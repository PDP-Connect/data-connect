// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Proves the release design by execution: registry-state classification,
// the publish-ordering barrier and its propagation budget, the workflow
// wiring, and resolve-release-version's
// decide() — which always resolves to an ordinary release and additionally
// reports a partially-published newest tag as superseded rather than
// repairing it: a partial prior version is named in the log and left for
// the next release to supersede.
//
// The registry is exercised through a stub `npm` on PATH that emits npm's
// REAL error and success shapes (verified against the live registry: a
// genuine miss emits `npm error code E404`, and `npm view <spec> version
// --json` answers with a JSON array like ["2.2.1"], not a bare string).
// Nothing here contacts the network, and nothing here publishes.

import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"

import {
  RegistryUnknownError,
  isRegistryMissingError,
  normalizeVersion,
} from "./release-registry-state.js"
import { awaitPublished } from "./verify-release-complete.js"
import {
  PACKAGE_NAME as BARRIER_PACKAGE_NAME,
  barrierFailureMessage,
} from "./verify-connector-protocol-published.js"

const REPO_ROOT = resolve(__dirname, "..")

// --- stub npm -------------------------------------------------------------

interface StubSpec {
  // package@version -> "published" | "missing" | a raw npm error to emit
  view: Record<string, "published" | "missing" | { error: string; code?: number }>
  // package names whose `npm publish` should fail
  publishFails?: Record<string, string>
}

// Builds a directory containing an `npm` shim that answers `view` from a
// fixture and records every `publish` invocation to a log file.
function makeStubNpm(spec: StubSpec): {
  dir: string
  publishLog: string
  manifestLog: string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), "atomic-npm-"))
  const publishLog = join(dir, "publish.log")
  const manifestLog = join(dir, "manifest.log")
  writeFileSync(publishLog, "")
  writeFileSync(manifestLog, "")
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec))

  const shim = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs")
const spec = JSON.parse(readFileSync(${JSON.stringify(join(dir, "spec.json"))}, "utf8"))
const argv = process.argv.slice(2)

if (argv[0] === "view") {
  const target = argv[1]
  const state = spec.view[target]
  if (state === "published") {
    const version = target.slice(target.lastIndexOf("@") + 1)
    process.stdout.write(JSON.stringify([version]) + "\\n")
    process.exit(0)
  }
  if (state && typeof state === "object") {
    process.stderr.write(state.error + "\\n")
    process.exit(state.code ?? 1)
  }
  // Real npm's miss shape.
  process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/" + target + "\\n")
  process.exit(1)
}

if (argv[0] === "publish") {
  const pkgRoot = argv[1]
  appendFileSync(${JSON.stringify(publishLog)}, pkgRoot + "\\n")
  // Records the manifest EXACTLY as it stands when publish is invoked —
  // which is what npm would pack. This is how the suite sees the
  // prepare-pipeline edits (version, dependency pin) rather than trusting
  // that they were made.
  try {
    const manifest = JSON.parse(readFileSync(process.cwd() + "/" + pkgRoot + "/package.json", "utf8"))
    appendFileSync(${JSON.stringify(manifestLog)}, JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies || {},
    }) + "\\n")
  } catch (e) {
    appendFileSync(${JSON.stringify(manifestLog)}, JSON.stringify({ error: String(e) }) + "\\n")
  }
  const failures = spec.publishFails || {}
  for (const key of Object.keys(failures)) {
    if (pkgRoot.includes(key)) {
      process.stderr.write(failures[key] + "\\n")
      process.exit(1)
    }
  }
  process.stdout.write("+ published " + pkgRoot + "\\n")
  process.exit(0)
}

process.stderr.write("stub npm: unexpected invocation: " + argv.join(" ") + "\\n")
process.exit(2)
`
  const npmPath = join(dir, "npm")
  writeFileSync(npmPath, shim)
  chmodSync(npmPath, 0o755)

  return {
    dir,
    publishLog,
    manifestLog,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// An `npm` shim whose `view` answers walk a sequence, so a caller that asks
// once and a caller that retries are distinguishable. Every invocation is
// counted on disk, since the shim runs in its own process.
function makeSequencedViewNpm(
  answers: ("published" | "missing")[],
  options: { repeatLast?: boolean } = {}
): { dir: string; viewCount: () => number; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "barrier-npm-"))
  const countLog = join(dir, "view.log")
  writeFileSync(countLog, "")
  writeFileSync(
    join(dir, "answers.json"),
    JSON.stringify({ answers, repeatLast: options.repeatLast === true })
  )

  const shim = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs")
const argv = process.argv.slice(2)
if (argv[0] !== "view") {
  process.stderr.write("sequenced stub npm: unexpected invocation: " + argv.join(" ") + "\\n")
  process.exit(2)
}
const { answers, repeatLast } = JSON.parse(readFileSync(${JSON.stringify(join(dir, "answers.json"))}, "utf8"))
appendFileSync(${JSON.stringify(countLog)}, "view\\n")
const calls = readFileSync(${JSON.stringify(countLog)}, "utf8").split("\\n").filter(Boolean).length
const index = calls - 1
const answer = index < answers.length ? answers[index] : (repeatLast ? answers[answers.length - 1] : "missing")
const target = argv[1]
if (answer === "published") {
  const version = target.slice(target.lastIndexOf("@") + 1)
  process.stdout.write(JSON.stringify([version]) + "\\n")
  process.exit(0)
}
// Real npm's miss shape.
process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/" + target + "\\n")
process.exit(1)
`
  const npmPath = join(dir, "npm")
  writeFileSync(npmPath, shim)
  chmodSync(npmPath, 0o755)

  return {
    dir,
    viewCount: () => readFileSync(countLog, "utf8").split("\n").filter(Boolean).length,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// Drives the publish-ordering barrier through its REAL entrypoint — the
// exported `main` that `.releaserc.yaml`'s invocation runs — so the assertion
// lands on the script's own behaviour (argv handling, the registry read, the
// failure path) rather than on the retry primitive it happens to call, or on a
// stub standing in for it.
//
// The wait is passed as a PARAMETER, which is the only reason this can run
// in-process. There is deliberately no environment override and no test-mode
// branch in the script: the delay a release run uses is this function's default,
// and a test that wants a faster retry overrides the VALUE, not the code path.
// The attempt COUNT is left at its real value, so the budget is still spent.
//
// `main` reports through `process.exit`/stdout/stderr because it is a CLI, so
// those three are captured here and restored in `finally`.
async function runBarrier(
  stubDir: string,
  version: string,
  wait: { delayMs?: number } = {}
): Promise<{ status: number; stdout: string; stderr: string; sleeps: number[] }> {
  const { main } = await import("./verify-connector-protocol-published.js")

  const previousPath = process.env.PATH
  const previousArgv = process.argv
  const realExit = process.exit
  const realOut = process.stdout.write
  const realErr = process.stderr.write

  let stdout = ""
  let stderr = ""
  let status = 0
  // Every delay the barrier actually asked to wait. Recorded rather than
  // swallowed so a caller can assert WHICH delay the script used — including
  // the real default, when nothing is injected.
  const sleeps: number[] = []

  class ExitSignal extends Error {
    constructor(readonly code: number) {
      super(`process.exit(${code})`)
    }
  }

  process.env.PATH = `${stubDir}:${previousPath ?? ""}`
  process.argv = [process.argv[0]!, join(REPO_ROOT, "scripts/verify-connector-protocol-published.ts"), version]
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0)
  }) as typeof process.exit
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as typeof process.stderr.write

  try {
    // `delayMs` is forwarded only when the caller set it, so omitting it
    // exercises the script's REAL default. `sleepFn` records instead of
    // waiting, which is what keeps a default-delay assertion fast: the value
    // under test is the number the script chose, not time actually burned.
    await main({
      ...(wait.delayMs === undefined ? {} : { delayMs: wait.delayMs }),
      sleepFn: async ms => {
        sleeps.push(ms)
      },
    })
  } catch (error) {
    if (error instanceof ExitSignal) {
      status = error.code
    } else {
      // A real fault, not the CLI's own exit. Restore first, then surface it.
      process.stdout.write = realOut
      process.stderr.write = realErr
      throw error
    }
  } finally {
    process.env.PATH = previousPath
    process.argv = previousArgv
    process.exit = realExit
    process.stdout.write = realOut
    process.stderr.write = realErr
  }

  return { status, stdout, stderr, sleeps }
}

const V = "2.2.1"
const CP = `@pdpp/connector-protocol@${V}`
const CR = `@pdpp/collector-runtime@${V}`
const LC = `@pdpp/local-collector@${V}`

// --- registry-state classification ---------------------------------------

describe("registry state classification", () => {
  it("treats npm's real E404 line as missing", () => {
    expect(isRegistryMissingError("npm error code E404\nnpm error 404 Not Found")).toBe(true)
  })

  // The defect the signoff on the resume PR identified in the inherited
  // barrier: an unanchored `includes("E404")` misreads a server error whose
  // body quotes E404 as "not published", which is exactly the
  // "I could not tell" -> "not published" collapse the design forbids.
  it("does NOT treat a non-404 error that merely contains the substring E404 as missing", () => {
    expect(isRegistryMissingError("npm error code E500 trace E404")).toBe(false)
    expect(isRegistryMissingError("npm error code EAI_AGAIN retry-after E404")).toBe(false)
  })

  it("treats genuine non-404 failures as unknown, not missing", () => {
    expect(isRegistryMissingError("npm error code E500")).toBe(false)
    expect(isRegistryMissingError("npm error code ETIMEDOUT")).toBe(false)
    expect(isRegistryMissingError("npm error code E401")).toBe(false)
  })

  it("accepts npm's single-element array shape and refuses to flatten a range answer", () => {
    expect(normalizeVersion(["2.2.1"])).toBe("2.2.1")
    expect(normalizeVersion("2.2.1")).toBe("2.2.1")
    // A multi-element answer means the spec resolved as a range; flattening it
    // to the first element would silently answer a question nobody asked.
    expect(normalizeVersion(["2.2.0", "2.2.1"])).toBeNull()
    expect(normalizeVersion({})).toBeNull()
  })
})

// --- wiring ---------------------------------------------------------------

describe("release pipeline wiring", () => {
  const releaserc = readFileSync(join(REPO_ROOT, ".releaserc.yaml"), "utf8")
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/npm-release.yml"), "utf8")

  interface WorkflowStep {
    uses?: string
    run?: string
    with?: Record<string, string>
  }
  interface WorkflowJob {
    needs?: string | string[]
    permissions?: Record<string, string>
    if?: string
    steps?: WorkflowStep[]
  }
  const parsedWorkflow = load(workflow) as { jobs: Record<string, WorkflowJob> }

  it("publishes all three packages, in the order the barrier depends on", () => {
    // Count PLUGIN ENTRIES, not mentions — the surrounding comments name the
    // path too, and counting those would make this assertion pass for the
    // wrong reason.
    const npmEntries = releaserc.match(/^\s+- - "@semantic-release\/npm"$/gm) ?? []
    expect(npmEntries).toHaveLength(3)
    // connector-protocol publishes first, the barrier proves it is live, and
    // only then do the two packages that depend on it publish. Asserting the
    // ORDER, not just the membership: a reorder is what the barrier exists to
    // catch, and a set comparison would not see one.
    const order = [...releaserc.matchAll(/pkgRoot: "(packages\/[^"]+)"/g)].map(m => m[1])
    expect(order).toEqual([
      "packages/connector-protocol",
      "packages/collector-runtime",
      "packages/local-collector",
    ])
    const barrier = releaserc.indexOf("scripts/verify-connector-protocol-published.ts")
    expect(barrier).toBeGreaterThan(releaserc.indexOf('pkgRoot: "packages/connector-protocol"'))
    expect(barrier).toBeLessThan(releaserc.indexOf('pkgRoot: "packages/collector-runtime"'))
  })

  it("resolves the release mode before any publishing job runs", () => {
    expect(workflow).toContain("scripts/resolve-release-version.ts")
    expect(workflow).toMatch(/needs:\s*\[?resolve-version/)
  })

  // The barrier between connector-protocol's publish and collector-runtime's
  // is the step that actually failed v2.2.1: a single un-retried `npm view`
  // asked once, immediately after a publish, and read propagation lag as
  // "not published".
  it("gives the publish-ordering barrier a propagation budget", async () => {
    expect(releaserc).toContain("scripts/verify-connector-protocol-published.ts")

    // Exercises the real retry primitive the barrier calls, against a stub
    // registry that answers MISSING once and then PUBLISHED — the exact
    // propagation-lag shape that broke v2.2.1. Asserting that the source
    // text mentions `awaitPublished` would not distinguish the call from
    // the two header comments that also name it; a single un-retried
    // lookup has to actually fail this test.
    const stub = makeSequencedViewNpm(["missing", "published"])
    const sleeps: number[] = []
    const previousPath = process.env.PATH
    process.env.PATH = `${stub.dir}:${previousPath}`
    let viewCount: number
    try {
      await awaitPublished("@pdpp/connector-protocol", "9.9.9", {
        delayMs: 10,
        sleepFn: async ms => {
          sleeps.push(ms)
        },
      })
      viewCount = stub.viewCount()
    } finally {
      process.env.PATH = previousPath
      stub.cleanup()
    }

    // Asked twice, not once: it waited out the miss instead of reading
    // propagation lag as "not published".
    expect(viewCount).toBe(2)
    expect(sleeps.length).toBe(1)
    // The injected value, not a default: the primitive waits what it is told.
    expect(sleeps).toEqual([10])
  })

  it("tells an unanswerable registry apart from a genuinely absent package", () => {
    const spec = `${BARRIER_PACKAGE_NAME}@9.9.9`

    // UNKNOWN means the registry did not answer. Reporting it as "not
    // published" would tell the operator the release is missing a package
    // when the truth is that nothing could be determined.
    const unknown = barrierFailureMessage(
      spec,
      new RegistryUnknownError(spec, "npm error code E500")
    )
    expect(unknown).toContain("UNKNOWN")
    expect(unknown).toContain("E500")
    expect(unknown).not.toContain("isn't live yet")

    const missing = barrierFailureMessage(spec, new Error("npm error code E404"))
    expect(missing).toContain("isn't live yet")
    expect(missing).not.toContain("UNKNOWN")

    expect(BARRIER_PACKAGE_NAME).toBe("@pdpp/connector-protocol")
  })

  it("fails the publish-ordering barrier when the package never appears", async () => {
    // The budget must not be an unconditional pass: a package that stays
    // missing for the whole budget still has to stop the release.
    const stub = makeSequencedViewNpm(["missing"], { repeatLast: true })
    const previousPath = process.env.PATH
    process.env.PATH = `${stub.dir}:${previousPath}`
    let raised: unknown
    let viewCount: number
    try {
      await awaitPublished("@pdpp/connector-protocol", "9.9.9", { delayMs: 10, sleepFn: async () => {} })
    } catch (error) {
      raised = error
    } finally {
      viewCount = stub.viewCount()
      process.env.PATH = previousPath
      stub.cleanup()
    }

    expect(raised).toBeInstanceOf(Error)
    expect(String(raised)).toContain("9.9.9")
    expect(viewCount).toBeGreaterThan(1)
  })

  // The three tests above drive `awaitPublished` directly. That proves the
  // primitive retries, but not that the barrier SCRIPT is the thing calling
  // it — and the v2.2.1 incident was a hand-rolled single lookup inside this
  // script, not a collapsed loop inside the primitive. Restoring that script
  // body passes every assertion above. So the barrier is also exercised as
  // the program `.releaserc.yaml` runs, with the stub registry on PATH.
  it("routes the barrier script's own registry read through the retry budget", async () => {
    const stub = makeSequencedViewNpm(["missing", "published"])
    try {
      const result = await runBarrier(stub.dir, "9.9.9", { delayMs: 10 })

      // Asked twice and then succeeded: the script itself waited out the
      // propagation miss rather than reading lag as "not published". This is a
      // genuine MISSING-then-PUBLISHED transition through the real barrier
      // entrypoint against a stub registry — collapse the retry so the script
      // asks once and this goes red.
      expect(stub.viewCount()).toBe(2)
      expect(result.sleeps).toEqual([10])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("confirmed @pdpp/connector-protocol@9.9.9 is live")
    } finally {
      stub.cleanup()
    }
  })

  // The injected wait exists so a test need not burn a real propagation budget.
  // That convenience is also a hazard: an edit could set the default to a test-
  // sized delay and every other test here would still pass, because they all
  // pass their own. So the DEFAULT itself is asserted — against the barrier
  // entrypoint, with nothing injected — and it must be the real 30 seconds.
  it("waits the real 30 seconds by default, with nothing injected", async () => {
    const stub = makeSequencedViewNpm(["missing", "published"])
    try {
      const result = await runBarrier(stub.dir, "9.9.9")

      // The script chose 30_000 on its own. Recorded rather than waited, so
      // asserting the real delay costs no real time.
      expect(result.sleeps).toEqual([30_000])
      expect(result.status).toBe(0)
      expect(stub.viewCount()).toBe(2)
    } finally {
      stub.cleanup()
    }
  })

  // The same default, read at the primitive and as the derived budget, so a
  // change to either the delay or the attempt count has to come here and say so.
  it("derives the propagation budget from the real delay and attempt count", async () => {
    const { PROPAGATION_DELAY_MS, PROPAGATION_BUDGET_MS } = await import("./verify-release-complete.js")

    expect(PROPAGATION_DELAY_MS).toBe(30_000)
    // 8 attempts sleep 7 times = 210s, above the ~180s lag measured for these
    // packages. A budget at or below that lag would fail healthy releases.
    expect(PROPAGATION_BUDGET_MS).toBe(210_000)
    expect(PROPAGATION_BUDGET_MS).toBeGreaterThan(180_000)
  })

  // No environment variable may influence the wait. The previous revision of
  // this step read `PDPP_PROPAGATION_DELAY_MS`, which put a test-only code path
  // in a production script — the same "trust the pipeline's own report" defect
  // class this whole step exists to catch. This test is what keeps it out.
  //
  // This one DOES need a child process, and for a specific reason: an override
  // of this shape is read at module scope, so by the time a test body could set
  // the variable, the read has already happened and an in-process assertion
  // passes no matter what the module does. Verified: re-introducing the override
  // and setting the variable in-test was NOT detected, while the child below
  // fails. The variable must therefore be in the environment BEFORE the module
  // is imported, which only a fresh process can arrange.
  it("ignores the environment when choosing how long to wait", () => {
    const tsxEntry = require.resolve("tsx")
    const probe = `
      import { PROPAGATION_DELAY_MS, PROPAGATION_BUDGET_MS } from ${JSON.stringify(
        join(REPO_ROOT, "scripts/verify-release-complete.ts")
      )}
      process.stdout.write(JSON.stringify({ PROPAGATION_DELAY_MS, PROPAGATION_BUDGET_MS }))
    `
    const dir = mkdtempSync(join(tmpdir(), "propagation-env-"))
    const probePath = join(dir, "probe.mts")
    writeFileSync(probePath, probe)
    try {
      const stdout = execFileSync(process.execPath, ["--import", tsxEntry, probePath], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        // Set before the module is imported — the only timing at which a
        // module-scope override could take effect.
        env: { ...process.env, PDPP_PROPAGATION_DELAY_MS: "7" },
      })
      const seen = JSON.parse(stdout) as { PROPAGATION_DELAY_MS: number; PROPAGATION_BUDGET_MS: number }

      // Still the real values: the variable is dead, not merely unread here.
      expect(seen.PROPAGATION_DELAY_MS).toBe(30_000)
      expect(seen.PROPAGATION_BUDGET_MS).toBe(210_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("accepts a live version from the array shape npm 11 answers with", async () => {
    // `npm view <spec> version --json` answers `["9.9.9"]`, not "9.9.9". The
    // barrier's pre-fix body compared that array to the version string and
    // so rejected a version that was genuinely live — reported, absurdly, as
    // `resolved version "9.9.9" does not match expected "9.9.9"`.
    const stub = makeSequencedViewNpm(["published"])
    try {
      const result = await runBarrier(stub.dir, "9.9.9", { delayMs: 10 })

      expect(stub.viewCount()).toBe(1)
      expect(result.status).toBe(0)
      expect(result.stderr).not.toContain("does not match expected")
    } finally {
      stub.cleanup()
    }
  })

  it("stops the release from the barrier script when the package never appears", async () => {
    // Fails closed, as the program and not just as the primitive, naming the
    // package rather than reporting an unanswerable registry.
    const stub = makeSequencedViewNpm(["missing"], { repeatLast: true })
    try {
      const result = await runBarrier(stub.dir, "9.9.9", { delayMs: 10 })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("@pdpp/connector-protocol@9.9.9")
      expect(result.stderr).toContain("isn't live yet")
      expect(result.stderr).not.toContain("UNKNOWN")
      // Every attempt in the budget was spent before believing the miss.
      expect(stub.viewCount()).toBe(8)
    } finally {
      stub.cleanup()
    }
  })

  it("runs the quality job before publishing", () => {
    // The release job must depend on quality, or a release could ship an
    // unverified tarball.
    expect(parsedWorkflow.jobs.release.needs).toContain("quality")
  })

  it("verifies the whole lockstep set is live after the release", () => {
    expect(workflow).toContain("scripts/verify-release-complete.ts")
    // Asserted against the PARSED job, not a file-wide substring match: the
    // verification has to run after the actual publish, using the version
    // resolve-version resolved, or it could pass while checking nothing this
    // run published.
    const verifyJob = parsedWorkflow.jobs["verify-release-complete"]
    expect(verifyJob?.needs).toEqual(["resolve-version", "release"])
    const steps = verifyJob?.steps ?? []
    const verifyStep = steps.find(s => String(s.run ?? "").includes("verify-release-complete.ts"))
    expect(verifyStep).toBeDefined()
    expect(String(verifyStep?.run ?? "")).toContain(
      "${{ needs.resolve-version.outputs.new-release-version }}"
    )
  })

  // The superseded report is REPORTING, not a gate: it must be gated on a
  // superseded version existing, or a run with a complete prior release
  // would print a sentence claiming one that does not exist.
  it("reports a superseded version only when there is one", () => {
    const steps = parsedWorkflow.jobs["verify-release-complete"]?.steps ?? []
    const report = steps.find(s => String(s.run ?? "").includes("report-superseded-release.ts"))
    expect(report).toBeDefined()
    expect(String(report?.if ?? "")).toContain(
      "needs.resolve-version.outputs.superseded-version != ''"
    )
  })

  // A forced release rewrites the commit-analyzer's rules and passes every
  // other plugin entry through. If it rewrote or dropped the npm entries, a
  // forced run would publish a different set of packages than an ordinary
  // release — forcing is meant to change which commits count, nothing else.
  it("keeps all three npm publishes on the forced-release path too", async () => {
    const { buildForcedReleaseConfig } = await import("./forced-release-config.js")
    const cfg = buildForcedReleaseConfig("patch", REPO_ROOT)
    const npmPublishes = cfg.plugins.filter(
      (p: unknown) => Array.isArray(p) && p[0] === "@semantic-release/npm"
    )
    expect(npmPublishes).toHaveLength(3)
  })
})

// --- the resolver's decision ----------------------------------------------

// decide() always resolves to an ordinary release; it additionally reports a
// partially-published newest tag as superseded, so the workflow can name what
// a prior interrupted release is missing instead of leaving it undiscovered.
// It had no test at all: the suite only checked that the workflow MENTIONED
// the file, so sabotaging the decision itself — swallowing an UNKNOWN
// registry answer and reporting `release` anyway, or reporting the wrong
// missing set — left the suite green.
describe("resolve-release-version decide()", () => {
  // decide() reads real git tags and the real registry, so it gets a scratch
  // repository and a stubbed npm rather than a mocked module: the thing under
  // test is how it reconciles those two sources.
  function makeTaggedRepo(tags: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "atomic-git-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      })
    git("init", "-q", "-b", "main")
    writeFileSync(join(dir, "f"), "x")
    git("add", "f")
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "c")
    for (const tag of tags) git("tag", tag)
    return dir
  }

  // Runs decide() in a child process so the stubbed npm is a real PATH
  // resolution, the same way the script resolves it in CI.
  function runDecide(
    repo: string,
    stubDir: string
  ): { status: number; stdout: string; stderr: string } {
    const tsxEntry = require.resolve("tsx")
    const script = `
      import { decide } from ${JSON.stringify(join(REPO_ROOT, "scripts/resolve-release-version.ts"))}
      const d = await decide(process.argv[2])
      process.stdout.write(JSON.stringify(d))
    `
    const entry = join(stubDir, "decide-entry.mts")
    writeFileSync(entry, script)
    try {
      const stdout = execFileSync(process.execPath, ["--import", tsxEntry, entry, repo], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
      })
      return { status: 0, stdout, stderr: "" }
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
    }
  }

  it("routes a fully published tag to an ordinary release", () => {
    const repo = makeTaggedRepo([`v${V}`])
    const stub = makeStubNpm({ view: { [CP]: "published", [CR]: "published", [LC]: "published" } })
    try {
      const result = runDecide(repo, stub.dir)
      expect(result.status).toBe(0)
      const decision = JSON.parse(result.stdout) as { mode: string; reason: string }
      expect(decision.mode).toBe("release")
      expect(decision.reason).toMatch(/fully published/)
    } finally {
      stub.cleanup()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // A partial prior version is reported, not repaired — the next release
  // supersedes it rather than resuming it.
  it("routes a partially published tag to an ordinary release and names what is missing", () => {
    const repo = makeTaggedRepo([`v${V}`])
    const stub = makeStubNpm({ view: { [CP]: "published", [CR]: "missing", [LC]: "missing" } })
    try {
      const result = runDecide(repo, stub.dir)
      expect(result.status).toBe(0)
      const decision = JSON.parse(result.stdout) as {
        mode: string
        reason: string
        superseded?: { tag: string; version: string; missing: string[] }
      }
      expect(decision.mode).toBe("release")
      expect(decision.superseded?.version).toBe(V)
      expect(decision.superseded?.tag).toBe(`v${V}`)
      expect(decision.superseded?.missing).toEqual(["@pdpp/collector-runtime", "@pdpp/local-collector"])
      expect(decision.reason).toMatch(/The next successful release will supersede it\./)
    } finally {
      stub.cleanup()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // A tag with NOTHING published is not a partial release — there is no
  // partial set to report as superseded, and this is a real behaviour
  // difference the suite previously could not see.
  it("routes a zero-published tag to an ordinary release with nothing superseded", () => {
    const repo = makeTaggedRepo([`v${V}`])
    const stub = makeStubNpm({ view: { [CP]: "missing", [CR]: "missing", [LC]: "missing" } })
    try {
      const result = runDecide(repo, stub.dir)
      expect(result.status).toBe(0)
      const decision = JSON.parse(result.stdout) as { mode: string; reason: string }
      expect(decision.mode).toBe("release")
      expect(decision.reason).toMatch(/no published packages/)
    } finally {
      stub.cleanup()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("treats a repository with no release tag as an ordinary release", () => {
    const repo = makeTaggedRepo([])
    const stub = makeStubNpm({ view: {} })
    try {
      const result = runDecide(repo, stub.dir)
      expect(result.status).toBe(0)
      expect((JSON.parse(result.stdout) as { mode: string }).mode).toBe("release")
    } finally {
      stub.cleanup()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // The property the file's header calls SAFETY. A registry outage must not be
  // able to make a COMPLETE release look partial and pull the pipeline into
  // re-publishing something that already shipped.
  it("throws rather than deciding anything when the registry will not answer", () => {
    const repo = makeTaggedRepo([`v${V}`])
    const stub = makeStubNpm({
      view: {
        [CP]: "published",
        [CR]: { error: "npm error code E500\nnpm error 500 Internal Server Error" },
        [LC]: "missing",
      },
    })
    try {
      const result = runDecide(repo, stub.dir)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/UNKNOWN/)
      // Decisively: no decision was emitted at all.
      expect(result.stdout).toBe("")
    } finally {
      stub.cleanup()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // The exact misclassification the #100 review found: an E500 whose body
  // happens to quote E404 must stay UNKNOWN, not degrade to "not published".
  it("does not let an E500 quoting E404 masquerade as a missing package", () => {
    const repo = makeTaggedRepo([`v${V}`])
    const stub = makeStubNpm({
      view: {
        [CP]: "published",
        [CR]: { error: "npm error code E500 trace E404" },
        [LC]: "published",
      },
    })
    try {
      const result = runDecide(repo, stub.dir)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/UNKNOWN/)
    } finally {
      stub.cleanup()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("picks the newest tag by version order, not lexically", () => {
    const repo = makeTaggedRepo(["v2.9.0", "v2.10.0"])
    const stub = makeStubNpm({
      view: {
        "@pdpp/connector-protocol@2.10.0": "published",
        "@pdpp/collector-runtime@2.10.0": "missing",
        "@pdpp/local-collector@2.10.0": "missing",
      },
    })
    try {
      const result = runDecide(repo, stub.dir)
      expect(result.status).toBe(0)
      const decision = JSON.parse(result.stdout) as {
        mode: string
        superseded?: { tag: string; version: string }
      }
      expect(decision.mode).toBe("release")
      // Lexically "v2.9.0" sorts above "v2.10.0"; semantically it does not.
      expect(decision.superseded?.version).toBe("2.10.0")
      expect(decision.superseded?.tag).toBe("v2.10.0")
    } finally {
      stub.cleanup()
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// --- the line CI prints about a superseded version ------------------------

// The policy's only externally visible artifact when a version is left
// incomplete. If this sentence is wrong or absent, the gap in the registry is
// invisible to everyone reading the release log, which is the one obligation
// Policy 2 accepts in exchange for not repairing the version.
describe("the superseded-version report", () => {
  it("names what is live, what is missing, and which version supersedes it", async () => {
    const { supersededMessage } = await import("./resolve-release-version.js")
    expect(
      supersededMessage(
        { tag: `v${V}`, version: V, missing: ["@pdpp/collector-runtime", "@pdpp/local-collector"] },
        "2.3.0"
      )
    ).toBe(
      `v${V} is incomplete on npm (connector-protocol only; ` +
        `missing collector-runtime, local-collector) and is superseded by 2.3.0`
    )
  })

  // The workflow hands the script three strings from job outputs. Driving the
  // real entry point proves the wiring produces the sentence above, rather
  // than proving only that the formatter works when called directly.
  it("is what the workflow's reporting step actually prints", () => {
    const tsxEntry = require.resolve("tsx")
    const stdout = execFileSync(
      process.execPath,
      [
        "--import",
        tsxEntry,
        join(REPO_ROOT, "scripts/report-superseded-release.ts"),
        `v${V}`,
        "@pdpp/collector-runtime,@pdpp/local-collector",
        "2.3.0",
      ],
      { encoding: "utf8" }
    )
    expect(stdout.trim()).toBe(
      `v${V} is incomplete on npm (connector-protocol only; ` +
        `missing collector-runtime, local-collector) and is superseded by 2.3.0`
    )
  })

  // A run with nothing superseded must not print a sentence claiming one.
  // The workflow guards this with an `if:`, and the script refuses too.
  it("refuses to report when no packages are missing", () => {
    const tsxEntry = require.resolve("tsx")
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--import",
          tsxEntry,
          join(REPO_ROOT, "scripts/report-superseded-release.ts"),
          `v${V}`,
          "",
          "2.3.0",
        ],
        { encoding: "utf8", stdio: "pipe" }
      )
    ).toThrow()
  })

})
