// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Proves the atomic-release design by execution, including the three crash
// points the design exists to survive:
//
//   - killed between publish one and two
//   - killed after publishing but before the tag/release step completed
//   - registry unreachable mid-publish
//
// The registry is exercised through a stub `npm` on PATH that emits npm's
// REAL error and success shapes (verified against the live registry: a
// genuine miss emits `npm error code E404`, and `npm view <spec> version
// --json` answers with a JSON array like ["2.2.1"], not a bare string).
// Nothing here contacts the network, and nothing here publishes.

import { execFileSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { load } from "js-yaml"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  isRegistryMissingError,
  normalizeVersion,
} from "./release-registry-state.js"

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
  buildLog: string
  dryRunLog: string
  argvLog: string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), "atomic-npm-"))
  const publishLog = join(dir, "publish.log")
  const manifestLog = join(dir, "manifest.log")
  const buildLog = join(dir, "build.log")
  const argvLog = join(dir, "argv.log")
  writeFileSync(publishLog, "")
  writeFileSync(manifestLog, "")
  writeFileSync(buildLog, "")
  writeFileSync(argvLog, "")
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec))

  const shim = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs")
const spec = JSON.parse(readFileSync(${JSON.stringify(join(dir, "spec.json"))}, "utf8"))
const argv = process.argv.slice(2)
// Every invocation's full argv, so a test can assert on the flags the driver
// passed rather than inferring them from behaviour.
appendFileSync(${JSON.stringify(argvLog)}, argv.join(" ") + "\\n")

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

// The already-live siblings' builds. A converge skips the live packages, so
// their prepacks never run and their dist/ never appears — the dependent's
// own prepack then fails on the missing type declarations. The driver builds
// them itself; this records which ones, and creates the dist/ the driver
// then asserts on, so the suite can check both the WHICH and the ordering
// without running a real tsc.
if (argv[0] === "run" && argv[1] === "build" && argv[2] === "--workspace") {
  const { mkdirSync, writeFileSync } = require("node:fs")
  const { resolve } = require("node:path")
  const workspace = argv[3]
  appendFileSync(${JSON.stringify(buildLog)}, workspace + "\\n")
  const dist = resolve(process.cwd(), workspace, "dist")
  mkdirSync(dist, { recursive: true })
  writeFileSync(resolve(dist, "index.d.ts"), "")
  process.stdout.write("stub npm: built " + workspace + "\\n")
  process.exit(0)
}

if (argv[0] === "publish") {
  // Real npm takes either a relative or an ABSOLUTE directory here, and the
  // converge driver passes an absolute one: its package root is the tagged
  // checkout, which is not under its cwd. Resolved the way npm resolves it,
  // then logged RELATIVE to cwd so the assertions keep naming packages rather
  // than temp-directory paths.
  const { resolve, relative } = require("node:path")
  const absolute = resolve(process.cwd(), argv[1])
  const pkgRoot = relative(process.cwd(), absolute) || argv[1]
  // A dry run reaches this command too — that is the point of it, since
  // prepack is where the converge used to die — but it writes nothing to the
  // registry, so it must not be recorded as a publish. Logged separately so
  // "published nothing" assertions stay meaningful while still proving the
  // pack path executed.
  const isDryRun = argv.includes("--dry-run")
  appendFileSync(isDryRun ? ${JSON.stringify(join(dir, "dry-run.log"))} : ${JSON.stringify(publishLog)}, pkgRoot + "\\n")
  if (isDryRun) {
    process.stdout.write("+ dry-run " + pkgRoot + "\\n")
    process.exit(0)
  }
  // Records the manifest EXACTLY as it stands when publish is invoked —
  // which is what npm would pack. This is how the suite sees the
  // prepare-pipeline edits (version, dependency pin) rather than trusting
  // that they were made.
  try {
    const manifest = JSON.parse(readFileSync(absolute + "/package.json", "utf8"))
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

  // converge-release.ts publishes through node_modules/.bin/npm, never the
  // ambient one (see resolveNpmBin — the runner's npm 10 cannot authenticate
  // via OIDC). So the stub has to be reachable at that path for the suite to
  // exercise the real code path. `nodeModulesBin` below is placed on the
  // synthetic cwd each run uses.
  const binDir = join(dir, "node_modules", ".bin")
  mkdirSync(binDir, { recursive: true })

  return {
    dir,
    publishLog,
    manifestLog,
    buildLog,
    dryRunLog: join(dir, "dry-run.log"),
    argvLog,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// Full argv of each stub npm invocation, in order.
function readArgvLog(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").map(l => l.trim()).filter(Boolean)
}

function readPublishLog(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").map(l => l.trim()).filter(Boolean)
}

interface PublishedManifest {
  name: string
  version: string
  dependencies: Record<string, string>
}

// The manifests as handed to `npm publish`, in publish order.
function readManifestLog(path: string): PublishedManifest[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as PublishedManifest)
}

// The converge path's two roots, staged as two separate real directories.
//
// They are separate in production because they are separate in time: the
// PACKAGE SOURCE is a checkout of the tag being converged, and the TOOLING is
// a checkout of the current revision that supplies the driver and the npm it
// publishes through. Collapsing them here would make this suite pass on an
// arrangement CI cannot run — which is exactly what happened before: every
// test below was green while the real job could not resolve its own
// entrypoint, because the harness handed the driver a cwd that had everything.
//
// So the driver is COPIED into the tooling root and executed from there. Its
// TOOLING_ROOT comes from import.meta.url, so running the copy is what makes
// resolveNpmBin look in the tooling root — the same resolution CI performs.
function stageConverge(
  stubDir: string | null
): { toolingRoot: string; packageSource: string; driver: string; cleanup: () => void } {
  const toolingRoot = mkdtempSync(join(tmpdir(), "atomic-tooling-"))
  const packageSource = mkdtempSync(join(tmpdir(), "atomic-pkgsrc-"))

  // Only packages/ — deliberately no scripts/, mirroring the tag, whose tree
  // has package sources and no converge-release.ts.
  cpSync(join(REPO_ROOT, "packages"), join(packageSource, "packages"), { recursive: true })

  mkdirSync(join(toolingRoot, "scripts"), { recursive: true })
  for (const file of ["converge-release.ts", "release-registry-state.ts"]) {
    cpSync(join(REPO_ROOT, "scripts", file), join(toolingRoot, "scripts", file))
  }
  // The driver is ESM and uses top-level await, so the tooling root needs the
  // `"type": "module"` its real checkout carries — without it tsx transforms
  // the entrypoint as CJS and it fails to parse. A real converge checkout has
  // this by construction; the stage has to supply it deliberately.
  writeFileSync(
    join(toolingRoot, "package.json"),
    JSON.stringify({ name: "converge-tooling-stage", private: true, type: "module" })
  )

  // `null` stages a tooling root with no local npm, to exercise the refusal in
  // resolveNpmBin.
  if (stubDir) {
    const binDir = join(toolingRoot, "node_modules", ".bin")
    mkdirSync(binDir, { recursive: true })
    cpSync(join(stubDir, "npm"), join(binDir, "npm"))
    chmodSync(join(binDir, "npm"), 0o755)
  }

  return {
    toolingRoot,
    packageSource,
    driver: join(toolingRoot, "scripts", "converge-release.ts"),
    cleanup: () => {
      rmSync(toolingRoot, { recursive: true, force: true })
      rmSync(packageSource, { recursive: true, force: true })
    },
  }
}

function execConverge(
  stage: { toolingRoot: string; packageSource: string; driver: string },
  stubDir: string,
  env: Record<string, string | undefined>
): { status: number; stdout: string; stderr: string } {
  // Resolved rather than hardcoded so the suite runs both against the repo's
  // own install and against an isolated toolchain (this repo's `npm ci` cannot
  // complete in every environment).
  const tsxEntry = require.resolve("tsx")
  try {
    const stdout = execFileSync(process.execPath, ["--import", tsxEntry, stage.driver], {
      cwd: stage.toolingRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        // The driver branches on GITHUB_ACTIONS, and the suite itself runs
        // inside GitHub Actions, so inheriting it silently rewrites the
        // scenario under test: the non-loopback case hit the
        // running-in-Actions refusal instead of the loopback guard, passing
        // locally and failing in CI. Cleared here so a test that cares about
        // that branch has to say so (see the GITHUB_ACTIONS case below), and
        // so a test that does not is exercising the same guard everywhere.
        GITHUB_ACTIONS: undefined,
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        CONVERGE_PACKAGE_SOURCE: stage.packageSource,
        ...env,
      },
    })
    return { status: 0, stdout, stderr: "" }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

// Runs converge-release.ts with a stubbed npm, returning its outcome rather
// than throwing, so a refusal can be asserted on.
function runConverge(
  stubDir: string,
  env: Record<string, string | undefined>
): { status: number; stdout: string; stderr: string } {
  const stage = stageConverge(stubDir)
  try {
    return execConverge(stage, stubDir, env)
  } finally {
    stage.cleanup()
  }
}

// A converge run whose TOOLING root deliberately has no node_modules/.bin/npm,
// to exercise the refusal in resolveNpmBin. The package source is unaffected:
// the npm that matters is the tooling checkout's, because the tag's own
// lockfile predates the npm 11 that OIDC publishing requires.
function runConvergeWithoutLocalNpm(
  stubDir: string,
  env: Record<string, string | undefined>
): { status: number; stdout: string; stderr: string } {
  const stage = stageConverge(null)
  try {
    return execConverge(stage, stubDir, env)
  } finally {
    stage.cleanup()
  }
}

const V = "2.2.1"
const CP = `@pdpp/connector-protocol@${V}`
const CR = `@pdpp/collector-runtime@${V}`
const LC = `@pdpp/local-collector@${V}`

const MAIN_ENV = { GITHUB_REF: "refs/heads/main", CONVERGE_RELEASE_TAG: `v${V}` }

const MANIFEST_PATHS = [
  "packages/connector-protocol/package.json",
  "packages/collector-runtime/package.json",
  "packages/local-collector/package.json",
]

// A non-dry-run converge legitimately writes the release version into each
// manifest it publishes (that is what @semantic-release/npm's prepare step
// does too). In CI that happens in an ephemeral checkout and is discarded;
// here it would dirty the real working tree, so the suite restores the
// manifests itself rather than leaving that to the person running it.
beforeEach(() => {
  manifestSnapshot = MANIFEST_PATHS.map(p => readFileSync(join(REPO_ROOT, p), "utf8"))
})

afterEach(() => {
  MANIFEST_PATHS.forEach((p, i) => {
    const path = join(REPO_ROOT, p)
    if (readFileSync(path, "utf8") !== manifestSnapshot[i]) {
      writeFileSync(path, manifestSnapshot[i] as string)
    }
  })
})

let manifestSnapshot: string[] = []

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

// --- the concrete stuck state --------------------------------------------

describe("the half-published v2.2.1 release currently in the repository", () => {
  it("publishes exactly the two missing packages and republishes nothing", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      const result = runConverge(stub.dir, MAIN_ENV)
      expect(result.status).toBe(0)

      const published = readPublishLog(stub.publishLog)
      // connector-protocol@2.2.1 is live and immutable — it must not be touched.
      expect(published).not.toContain("packages/connector-protocol")
      expect(published).toEqual(["packages/collector-runtime", "packages/local-collector"])
      expect(result.stdout).toContain("skipping @pdpp/connector-protocol")
    } finally {
      stub.cleanup()
    }
  })

  // The defect that made the previous head unrunnable. A converge skips the
  // live siblings, so nothing builds their dist/, so the dependent's prepack
  // fails with TS2307 before packing. Reproduced at v2.2.1 against the real
  // tree; asserted here on the driver's behaviour.
  it("builds the already-live sibling the dependents typecheck against", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      const result = runConverge(stub.dir, MAIN_ENV)
      expect(result.status).toBe(0)

      const built = readPublishLog(stub.buildLog)
      expect(
        built,
        "connector-protocol is live, so its own prepack never runs — the converge must build it, or " +
          "collector-runtime's prepack fails on the missing dist/"
      ).toContain("packages/connector-protocol")
    } finally {
      stub.cleanup()
    }
  })

  // Builds every live sibling a selected package declares, not just the one
  // v2.2.1 happens to need: local-collector declares both, so with both live
  // both are built. Read from the manifests rather than hardcoded, so a tag
  // with different edges is handled by the same code.
  it("builds every already-live sibling the selected package declares", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "published", [LC]: "missing" },
    })
    try {
      const result = runConverge(stub.dir, MAIN_ENV)
      expect(result.status).toBe(0)
      const built = readPublishLog(stub.buildLog)
      expect(built).toContain("packages/connector-protocol")
      expect(built).toContain("packages/collector-runtime")
      expect(readPublishLog(stub.publishLog)).toEqual(["packages/local-collector"])
    } finally {
      stub.cleanup()
    }
  })

  // Only the SKIPPED siblings. One that is itself being published builds
  // during its own prepack, earlier in publish order, and pre-building it here
  // would run its build before this run's manifest edits.
  it("does not pre-build a sibling that is itself being published", () => {
    const stub = makeStubNpm({
      // connector-protocol live; collector-runtime and local-collector both
      // selected. local-collector declares collector-runtime, which is in the
      // publish set — so it must NOT be pre-built for local-collector.
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      const result = runConverge(stub.dir, MAIN_ENV)
      expect(result.status).toBe(0)
      expect(readPublishLog(stub.buildLog)).not.toContain("packages/collector-runtime")
    } finally {
      stub.cleanup()
    }
  })

  // The dry run has to reach prepack, because prepack is where this job died.
  // A dry run that returns before `npm publish` is a rehearsal of the part
  // that already worked — that is precisely how the previous head went green
  // while being unrunnable.
  it("reaches npm publish on the dry-run path, writing nothing", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      const result = runConverge(stub.dir, { ...MAIN_ENV, CONVERGE_RELEASE_DRY_RUN: "true" })
      expect(result.status).toBe(0)
      // It invoked the real publish command, with --dry-run...
      expect(readPublishLog(stub.dryRunLog)).toEqual([
        "packages/collector-runtime",
        "packages/local-collector",
      ])
      // ...and never a publish that would have written.
      expect(readPublishLog(stub.publishLog)).toEqual([])
      // And it built the live sibling first, or the real prepack would fail.
      expect(readPublishLog(stub.buildLog)).toContain("packages/connector-protocol")
    } finally {
      stub.cleanup()
    }
  })

  it("publishes in dependency order, not registry-response order", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      runConverge(stub.dir, MAIN_ENV)
      const published = readPublishLog(stub.publishLog)
      // collector-runtime's manifest pins connector-protocol, and
      // local-collector builds against both, so this order is load-bearing.
      expect(published.indexOf("packages/collector-runtime")).toBeLessThan(
        published.indexOf("packages/local-collector")
      )
    } finally {
      stub.cleanup()
    }
  })
})

// --- crash points ---------------------------------------------------------

describe("crash point: killed between publish one and publish two", () => {
  it("a re-run skips what landed and publishes only what did not", () => {
    // First converge run dies after collector-runtime publishes.
    const first = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
      publishFails: { "packages/local-collector": "npm error code E500 registry died" },
    })
    let firstPublished: string[]
    try {
      const result = runConverge(first.dir, MAIN_ENV)
      expect(result.status).not.toBe(0)
      firstPublished = readPublishLog(first.publishLog)
      expect(firstPublished).toContain("packages/collector-runtime")
    } finally {
      first.cleanup()
    }

    // The registry now reflects that partial progress. Re-running converges.
    const second = makeStubNpm({
      view: { [CP]: "published", [CR]: "published", [LC]: "missing" },
    })
    try {
      const result = runConverge(second.dir, MAIN_ENV)
      expect(result.status).toBe(0)
      // Strictly less missing than before, and nothing already-live retried.
      expect(readPublishLog(second.publishLog)).toEqual(["packages/local-collector"])
    } finally {
      second.cleanup()
    }
  })

  it("never leaves the working tree dirty, so a crashed run needs no cleanup", () => {
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" })
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
      publishFails: { "packages/local-collector": "npm error code E500" },
    })
    try {
      runConverge(stub.dir, { ...MAIN_ENV, CONVERGE_RELEASE_DRY_RUN: "true" })
    } finally {
      stub.cleanup()
    }
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" })
    expect(after).toBe(before)
  })
})

describe("crash point: killed after all publishes, before the run finished", () => {
  it("a re-run is a successful no-op rather than an error or a republish", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "published", [LC]: "published" },
    })
    try {
      const result = runConverge(stub.dir, MAIN_ENV)
      // The post-state is exactly what was wanted. Converging must not fail
      // on a race it does not need to win.
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("nothing to converge")
      expect(readPublishLog(stub.publishLog)).toEqual([])
    } finally {
      stub.cleanup()
    }
  })
})

describe("crash point: registry unreachable mid-publish", () => {
  it("aborts without publishing anything when the registry will not answer", () => {
    const stub = makeStubNpm({
      view: {
        [CP]: "published",
        [CR]: { error: "npm error code E500\nnpm error 500 Internal Server Error" },
        [LC]: "missing",
      },
    })
    try {
      const result = runConverge(stub.dir, MAIN_ENV)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/UNKNOWN/)
      // The decisive assertion: an unanswerable registry publishes NOTHING.
      // Guessing "missing" here would attempt to republish an immutable
      // version and fail with E403, or worse, publish against a wrong picture.
      expect(readPublishLog(stub.publishLog)).toEqual([])
    } finally {
      stub.cleanup()
    }
  })

  it("aborts on an auth failure rather than reading it as not-published", () => {
    const stub = makeStubNpm({
      view: { [CP]: { error: "npm error code E401\nnpm error 401 Unauthorized" }, [CR]: "missing", [LC]: "missing" },
    })
    try {
      const result = runConverge(stub.dir, MAIN_ENV)
      expect(result.status).not.toBe(0)
      expect(readPublishLog(stub.publishLog)).toEqual([])
    } finally {
      stub.cleanup()
    }
  })
})

// --- refusals -------------------------------------------------------------

describe("converge refusals", () => {
  it("refuses any ref other than main, before reading the registry", () => {
    const stub = makeStubNpm({ view: { [CP]: "published", [CR]: "missing", [LC]: "missing" } })
    try {
      const result = runConverge(stub.dir, { ...MAIN_ENV, GITHUB_REF: "refs/heads/feature" })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/only allowed on refs\/heads\/main/)
      expect(readPublishLog(stub.publishLog)).toEqual([])
    } finally {
      stub.cleanup()
    }
  })

  it("refuses when no ref is supplied at all", () => {
    const stub = makeStubNpm({ view: { [CP]: "published", [CR]: "missing", [LC]: "missing" } })
    try {
      const result = runConverge(stub.dir, { ...MAIN_ENV, GITHUB_REF: undefined })
      expect(result.status).not.toBe(0)
      expect(readPublishLog(stub.publishLog)).toEqual([])
    } finally {
      stub.cleanup()
    }
  })

  it("refuses a tag that is not of the form vX.Y.Z", () => {
    const stub = makeStubNpm({ view: {} })
    try {
      const result = runConverge(stub.dir, { ...MAIN_ENV, CONVERGE_RELEASE_TAG: "2.2.1" })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/not of the form/)
    } finally {
      stub.cleanup()
    }
  })

  it("refuses a tag with nothing published — that is a release, not a convergence", () => {
    const stub = makeStubNpm({
      view: { [CP]: "missing", [CR]: "missing", [LC]: "missing" },
    })
    try {
      const result = runConverge(stub.dir, MAIN_ENV)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/not a partially-completed release/)
      expect(readPublishLog(stub.publishLog)).toEqual([])
    } finally {
      stub.cleanup()
    }
  })
})

// --- manifest editing -----------------------------------------------------

describe("manifest version rewriting", () => {
  // Scoped to THIS helper: replaceManifestVersion is the version edit alone.
  // It is not the whole prepare pipeline, and must not be read as a statement
  // that a converge changes only the version — the dependency pin below is
  // the other edit publishing requires. Stating it that way is what let the
  // unpinned-manifest defect sit under a green suite.
  it("changes the version and nothing else in the manifest it is given", async () => {
    const { replaceManifestVersion } = await import("./converge-release.js")
    const raw = '{\n  "name": "@pdpp/x",\n  "version": "0.0.1",\n  "private": false\n}\n'
    expect(replaceManifestVersion(raw, "2.2.1")).toBe(
      '{\n  "name": "@pdpp/x",\n  "version": "2.2.1",\n  "private": false\n}\n'
    )
  })

  // A JSON.parse/stringify round-trip re-emits — as a literal em-dash,
  // leaving unrelated drift in the published tarball and the working tree.
  // Found by running the converge script for real and diffing the tree, not
  // by reading the code.
  it("preserves non-ASCII escapes it was never asked to touch", async () => {
    const { replaceManifestVersion } = await import("./converge-release.js")
    const raw = '{\n  "version": "0.0.1",\n  "description": "Connector-agnostic \\u2014 carries nothing."\n}\n'
    const out = replaceManifestVersion(raw, "2.2.1")
    expect(out).toContain("\\u2014")
    expect(out).not.toContain("—")
  })

  it("refuses a manifest with no version field rather than writing a broken one", async () => {
    const { replaceManifestVersion } = await import("./converge-release.js")
    expect(() => replaceManifestVersion('{\n  "name": "x"\n}\n', "2.2.1")).toThrow(/no top-level/)
  })
})

// --- the prepare pipeline converge must reproduce -------------------------

// The ordinary release runs a `prepare` lifecycle before publishing; a
// converge that skips it publishes a DIFFERENT artifact under the same
// version, and npm immutability makes that permanent. These tests assert the
// published manifest, not the intermediate steps, because the manifest is
// what actually ships.
describe("the manifest handed to npm publish", () => {
  it("pins the sibling dependency at the release version, not the committed placeholder", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      const result = runConverge(stub.dir, MAIN_ENV)
      expect(result.status).toBe(0)

      const manifests = readManifestLog(stub.manifestLog)
      const runtime = manifests.find(m => m.name === "@pdpp/collector-runtime")
      expect(runtime).toBeDefined()

      // The whole point. Left unpinned this reads "0.0.1", which EXISTS on the
      // registry — so the package would install cleanly against an ancient
      // protocol version, and the lockstep invariant would read true while
      // being false, permanently.
      expect(runtime?.dependencies["@pdpp/connector-protocol"]).toBe(V)
      expect(runtime?.version).toBe(V)
    } finally {
      stub.cleanup()
    }
  })

  it("carries the release version into every package it publishes", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      runConverge(stub.dir, MAIN_ENV)
      const manifests = readManifestLog(stub.manifestLog)
      expect(manifests.map(m => m.name)).toEqual([
        "@pdpp/collector-runtime",
        "@pdpp/local-collector",
      ])
      for (const m of manifests) expect(m.version).toBe(V)
    } finally {
      stub.cleanup()
    }
  })

  // The pin is an exact version, never a range: collector-runtime and
  // connector-protocol are lockstep-versioned, and a caret would let an
  // install resolve a protocol version this runtime was never built against.
  it("pins the sibling exactly, with no range operator", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      runConverge(stub.dir, MAIN_ENV)
      const runtime = readManifestLog(stub.manifestLog).find(
        m => m.name === "@pdpp/collector-runtime"
      )
      expect(runtime?.dependencies["@pdpp/connector-protocol"]).toMatch(/^\d+\.\d+\.\d+$/)
    } finally {
      stub.cleanup()
    }
  })

  it("applies the same edit the ordinary prepare step makes", async () => {
    // Not a second implementation of the rule: the converge helper and
    // pin-collector-runtime-protocol-dependency.ts must agree on the result,
    // or the two publishing paths ship different manifests.
    const { replaceDependencyVersion } = await import("./converge-release.js")
    const raw = readFileSync(join(REPO_ROOT, "packages/collector-runtime/package.json"), "utf8")
    const converged = JSON.parse(replaceDependencyVersion(raw, "@pdpp/connector-protocol", V)) as {
      dependencies: Record<string, string>
    }
    const prepared = JSON.parse(raw) as { dependencies: Record<string, string> }
    prepared.dependencies["@pdpp/connector-protocol"] = V
    expect(converged.dependencies).toEqual(prepared.dependencies)
  })

  it("preserves non-ASCII escapes when pinning, like the version edit does", async () => {
    const { replaceDependencyVersion } = await import("./converge-release.js")
    const raw =
      '{\n  "description": "Runtime \\u2014 nothing else.",\n  "dependencies": { "@pdpp/connector-protocol": "0.0.1" }\n}\n'
    const out = replaceDependencyVersion(raw, "@pdpp/connector-protocol", V)
    expect(out).toContain("\\u2014")
    expect(out).not.toContain("—")
    expect(out).toContain(`"@pdpp/connector-protocol": "${V}"`)
  })

  it("refuses a manifest with no such dependency rather than silently publishing unpinned", async () => {
    const { replaceDependencyVersion } = await import("./converge-release.js")
    expect(() => replaceDependencyVersion('{\n  "name": "x"\n}\n', "@pdpp/connector-protocol", V)).toThrow(
      /no "@pdpp\/connector-protocol" dependency/
    )
  })
})

// --- which npm runs the publish -------------------------------------------

// OIDC trusted publishing needs npm >= 11.5.1. The runner's ambient npm is
// 10, which has no trusted-publishing code at all, so a converge that shells
// out to bare "npm" cannot authenticate and the release cannot finish.
describe("the npm converge publishes through", () => {
  it("uses node_modules/.bin/npm rather than whatever npm is on PATH", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      // runConverge places the stub ONLY at <cwd>/node_modules/.bin/npm and
      // puts a different copy on PATH. Publishes recorded in this run's log
      // therefore prove the local binary was the one invoked.
      const result = runConverge(stub.dir, MAIN_ENV)
      expect(result.status).toBe(0)
      expect(readPublishLog(stub.publishLog)).toEqual([
        "packages/collector-runtime",
        "packages/local-collector",
      ])
    } finally {
      stub.cleanup()
    }
  })

  it("refuses to publish at all when the OIDC-capable npm is absent", () => {
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      const result = runConvergeWithoutLocalNpm(stub.dir, MAIN_ENV)
      // Fails closed, loudly, BEFORE any publish — not deep inside one with
      // an opaque auth error.
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/node_modules\/\.bin\/npm is not present/)
      expect(result.stderr).toMatch(/OIDC/)
      expect(readPublishLog(stub.publishLog)).toEqual([])
    } finally {
      stub.cleanup()
    }
  })

  // THE ACCEPTANCE ESCAPE HATCH'S FENCE.
  //
  // scripts/converge-release-acceptance.mjs needs the driver to pass
  // `--provenance=false`, because the packages' own publishConfig forces
  // provenance on and npm then refuses off a CI runner — so the real publish
  // path could not be exercised at all. That hatch disables a real security
  // property, so the fence around it is asserted here rather than trusted.
  describe("the acceptance-mode registry override", () => {
    const LOOPBACK = "http://127.0.0.1:9999/"

    // Every non-loopback shape a plausible misconfiguration takes, including
    // ones that merely CONTAIN a loopback spelling. A substring check would
    // accept the last three, and each of them resolves off this machine.
    it.each([
      "https://registry.npmjs.org/",
      "http://registry.internal.example.com/",
      "http://127.0.0.1.example.com/",
      "http://localhost.example.com/",
      "http://evil.example.com/?h=127.0.0.1",
    ])("refuses the non-loopback registry %s rather than falling back", registry => {
      const stub = makeStubNpm({
        view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
      })
      try {
        const result = runConverge(stub.dir, {
          ...MAIN_ENV,
          CONVERGE_ACCEPTANCE_LOCAL_REGISTRY: registry,
        })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/must point at a loopback address/)
        // Fails closed: nothing was published on the way to the refusal.
        expect(readPublishLog(stub.publishLog)).toEqual([])
        // And the refusal beat every network call. The stub records EVERY
        // invocation's argv, including the `npm view` registry reads, so an
        // empty log is positive evidence that the driver refused before it
        // could contact anything — not merely that it published nothing.
        // This is the assertion the guard's original position failed: it
        // validated the value only after lockstepRegistryState() had already
        // run three `npm view` calls against a real registry.
        expect(readArgvLog(stub.argvLog)).toEqual([])
      } finally {
        stub.cleanup()
      }
    })

    // The other direction, without which the refusals above could be produced
    // by a guard that rejects everything. A loopback value is ACCEPTED: the
    // run completes, publishes the two missing packages, and carries the
    // provenance override that is the whole reason the hatch exists.
    it.each(["http://127.0.0.1:9999/", "http://localhost:9999/", "http://[::1]:9999/"])(
      "accepts the loopback registry %s and publishes through it",
      registry => {
        const stub = makeStubNpm({
          view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
        })
        try {
          const result = runConverge(stub.dir, {
            ...MAIN_ENV,
            CONVERGE_ACCEPTANCE_LOCAL_REGISTRY: registry,
          })
          expect(result.status).toBe(0)
          expect(result.stderr).not.toMatch(/must point at a loopback address/)
          expect(readPublishLog(stub.publishLog)).toEqual([
            "packages/collector-runtime",
            "packages/local-collector",
          ])
          expect(readArgvLog(stub.argvLog).join("\n")).toMatch(/--provenance=false/)
        } finally {
          stub.cleanup()
        }
      }
    )

    // The one machine where honouring it would matter is the one that does
    // real releases, so there it is unreachable. GITHUB_ACTIONS is set
    // explicitly rather than inherited: execConverge clears it, because this
    // suite itself runs inside Actions and the inherited value was silently
    // turning the non-loopback case above into a second copy of this one.
    it("refuses outright inside GitHub Actions", () => {
      const stub = makeStubNpm({
        view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
      })
      try {
        const result = runConverge(stub.dir, {
          ...MAIN_ENV,
          CONVERGE_ACCEPTANCE_LOCAL_REGISTRY: LOOPBACK,
          GITHUB_ACTIONS: "true",
        })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/set inside GitHub Actions/)
        expect(readPublishLog(stub.publishLog)).toEqual([])
      } finally {
        stub.cleanup()
      }
    })

    // THE DEFECT THAT HID THE LOOPBACK GUARD FROM CI, asserted directly.
    //
    // The suite runs inside GitHub Actions, so before execConverge cleared
    // GITHUB_ACTIONS every case in this describe block inherited it and hit
    // the running-in-Actions refusal. The non-loopback case failed visibly,
    // which is how this was found — but the more dangerous reading is that
    // the loopback guard had NO CI coverage at all: whichever message the
    // assertion expected, the guard under test was never the one that ran.
    //
    // So this pins the harness rather than the driver: with GITHUB_ACTIONS
    // present in the parent process, a run that does not ask for it must
    // still reach the loopback guard.
    it("reaches the loopback guard even when the suite itself runs in Actions", () => {
      const stub = makeStubNpm({
        view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
      })
      const inherited = process.env.GITHUB_ACTIONS
      process.env.GITHUB_ACTIONS = "true"
      try {
        const result = runConverge(stub.dir, {
          ...MAIN_ENV,
          CONVERGE_ACCEPTANCE_LOCAL_REGISTRY: "https://registry.npmjs.org/",
        })
        expect(result.status).not.toBe(0)
        // The loopback guard's diagnosis, NOT the Actions one.
        expect(result.stderr).toMatch(/must point at a loopback address/)
        expect(result.stderr).not.toMatch(/set inside GitHub Actions/)
        expect(readPublishLog(stub.publishLog)).toEqual([])
      } finally {
        if (inherited === undefined) delete process.env.GITHUB_ACTIONS
        else process.env.GITHUB_ACTIONS = inherited
        stub.cleanup()
      }
    })

    // And an ordinary release must never carry the flag, or provenance would
    // be silently off on the real publishing path.
    it("passes no provenance override when unset", () => {
      const stub = makeStubNpm({
        view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
      })
      try {
        const result = runConverge(stub.dir, MAIN_ENV)
        expect(result.status).toBe(0)
        expect(readArgvLog(stub.argvLog).join("\n")).not.toMatch(/--provenance/)
      } finally {
        stub.cleanup()
      }
    })
  })

  it("resolves the local npm path from the working directory", async () => {
    const { resolveNpmBin } = await import("./converge-release.js")
    const dir = mkdtempSync(join(tmpdir(), "atomic-npmbin-"))
    try {
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true })
      writeFileSync(join(dir, "node_modules", ".bin", "npm"), "#!/bin/sh\n")
      expect(resolveNpmBin(dir)).toBe(join(dir, "node_modules", ".bin", "npm"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // package-lock.json hoists npm at node_modules/npm because
  // @semantic-release/npm depends on ^11.6.2. That is what makes
  // node_modules/.bin/npm an OIDC-capable npm rather than a link to the
  // ambient one, so the constraint is asserted rather than assumed.
  it("is backed by a lockfile pin at npm 11 or newer", () => {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string }>
    }
    const npmEntry = lock.packages["node_modules/npm"]
    expect(npmEntry).toBeDefined()
    const major = Number((npmEntry?.version ?? "0").split(".")[0])
    const minor = Number((npmEntry?.version ?? "0.0").split(".")[1])
    // npm 11.5.1 is where OIDC trusted-publishing auth landed.
    expect(major).toBeGreaterThanOrEqual(11)
    if (major === 11) expect(minor).toBeGreaterThanOrEqual(5)
  })
})

// --- the real manifests ---------------------------------------------------

describe("the three lockstep manifests", () => {
  it("are left byte-identical by a dry-run converge", () => {
    // The dry-run guard has to return BEFORE any write, or merely checking
    // what a converge would do dirties the tree.
    const paths = [
      "packages/connector-protocol/package.json",
      "packages/collector-runtime/package.json",
      "packages/local-collector/package.json",
    ]
    const before = paths.map(p => readFileSync(join(REPO_ROOT, p), "utf8"))
    const stub = makeStubNpm({
      view: { [CP]: "published", [CR]: "missing", [LC]: "missing" },
    })
    try {
      const result = runConverge(stub.dir, { ...MAIN_ENV, CONVERGE_RELEASE_DRY_RUN: "true" })
      expect(result.status).toBe(0)
      expect(readPublishLog(stub.publishLog)).toEqual([])
    } finally {
      stub.cleanup()
    }
    const after = paths.map(p => readFileSync(join(REPO_ROOT, p), "utf8"))
    expect(after).toEqual(before)
  })
})

// --- idempotent publish plugin -------------------------------------------

describe("idempotent publish plugin", () => {
  it("keeps its registry classification identical to the shared module's", async () => {
    // The plugin re-implements classification in plain JS because
    // semantic-release imports it with no TypeScript loader in scope. This
    // pins the two implementations together so they cannot drift.
    const plugin = await import("./idempotent-npm-publish.mjs")
    const cases = [
      "npm error code E404",
      "npm error code E500 trace E404",
      "npm error code E500",
      "npm error code ETIMEDOUT",
    ]
    for (const detail of cases) {
      expect(plugin.isRegistryMissingError(detail)).toBe(isRegistryMissingError(detail))
    }
    expect(plugin.normalizeVersion(["2.2.1"])).toBe(normalizeVersion(["2.2.1"]))
    expect(plugin.normalizeVersion(["2.2.0", "2.2.1"])).toBe(normalizeVersion(["2.2.0", "2.2.1"]))
  })

  it("exposes the full lifecycle semantic-release expects of an npm plugin", async () => {
    const plugin = await import("./idempotent-npm-publish.mjs")
    expect(typeof plugin.verifyConditions).toBe("function")
    expect(typeof plugin.prepare).toBe("function")
    expect(typeof plugin.publish).toBe("function")
    expect(typeof plugin.addChannel).toBe("function")
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

  it("routes every npm publish through the idempotent plugin", () => {
    // If any package published through the stock @semantic-release/npm, that
    // package would still be able to hard-fail a re-run with E403, and the
    // convergence property would hold for only part of the release.
    expect(releaserc).not.toMatch(/^\s+- - "@semantic-release\/npm"/m)
    // Count PLUGIN ENTRIES, not mentions — the surrounding comments name the
    // path too, and counting those would make this assertion pass for the
    // wrong reason.
    const idempotentEntries = releaserc.match(/^\s+- - "\.\/scripts\/idempotent-npm-publish\.mjs"$/gm) ?? []
    expect(idempotentEntries).toHaveLength(3)
  })

  it("resolves the release mode before any publishing job runs", () => {
    expect(workflow).toContain("scripts/resolve-release-version.ts")
    expect(workflow).toMatch(/needs:\s*\[?resolve-version/)
  })

  it("gates the converge job on main and on the converge decision", () => {
    expect(workflow).toMatch(/scripts\/converge-release\.ts/)
    // Asserted against the CONVERGE JOB'S OWN `if`, not the workflow text.
    // A file-wide substring match passes on the identical clause in
    // resolve-version, so deleting the converge job's gate left the suite
    // green — the script-level refusal still held, but the workflow-level one
    // was unpinned.
    const convergeIf = String(parsedWorkflow.jobs.converge.if ?? "")
    expect(convergeIf).toMatch(/mode == 'converge'/)
    expect(convergeIf).toMatch(/github\.ref == 'refs\/heads\/main'/)
  })

  // A converge builds the tarballs it publishes, so it must build them from
  // the tree the tag names — not from the push head that happened to trigger
  // the run. local-collector vendors connector-protocol's built dist/ into its
  // own tarball, so a head-built local-collector@X can embed protocol code
  // that the already-published connector-protocol@X does not have.
  it("checks out the tag being converged, not the push head", () => {
    const steps = parsedWorkflow.jobs.converge.steps ?? []
    const checkout = steps.find(s => String(s.uses ?? "").startsWith("actions/checkout"))
    expect(checkout).toBeDefined()
    expect(checkout?.with?.ref).toBe("${{ needs.resolve-version.outputs.converge-tag }}")
  })

  // The converge job shells out to node_modules/.bin/npm, which only exists
  // after an install. Without this step the job would hit the refusal in
  // resolveNpmBin and the release could never finish.
  it("installs dependencies before converging, so the OIDC-capable npm exists", () => {
    const steps = parsedWorkflow.jobs.converge.steps ?? []
    const installIndex = steps.findIndex(s => String(s.run ?? "").includes("npm ci"))
    const convergeIndex = steps.findIndex(s => String(s.run ?? "").includes("converge-release.ts"))
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(convergeIndex).toBeGreaterThan(installIndex)
  })

  // The barrier between connector-protocol's publish and collector-runtime's
  // is the step that actually failed v2.2.1: a single un-retried `npm view`
  // asked once, immediately after a publish, and read propagation lag as
  // "not published".
  it("gives the publish-ordering barrier a propagation budget", () => {
    expect(releaserc).toContain("scripts/verify-connector-protocol-published.ts")
    const barrier = readFileSync(join(REPO_ROOT, "scripts/verify-connector-protocol-published.ts"), "utf8")
    // Routed through the shared retry primitive rather than a third hand-rolled
    // registry client.
    expect(barrier).toMatch(/awaitPublished/)
    expect(barrier).not.toMatch(/JSON\.parse\(stdout/)
  })

  it("runs the quality job before either publishing path", () => {
    // Both the ordinary release job and the converge job must depend on
    // quality, or a converge could ship an unverified tarball.
    expect(parsedWorkflow.jobs.release.needs).toContain("quality")
    expect(parsedWorkflow.jobs.converge.needs).toContain("quality")
  })

  it("denies the converge job repository write access", () => {
    // Structural guarantee that converging cannot create a tag or a release:
    // it is not permitted to write refs at all. Asserted against the PARSED
    // job rather than a slice of the file, so prose in a neighbouring comment
    // cannot make this pass or fail for the wrong reason.
    expect(parsedWorkflow.jobs.converge.permissions.contents).toBe("read")
    expect(parsedWorkflow.jobs.release.permissions.contents).toBe("write")
  })

  it("verifies the whole lockstep set is live after either path", () => {
    expect(workflow).toContain("scripts/verify-release-complete.ts")
  })

  // A forced release rewrites the commit-analyzer's rules and passes every
  // other plugin entry through. If it rewrote or dropped the npm entries, a
  // forced run could still hard-fail on an already-live package with E403 and
  // the convergence property would hold for only some of the ways this repo
  // releases.
  it("keeps the idempotent publish plugin on the forced-release path too", async () => {
    const { buildForcedReleaseConfig } = await import("./forced-release-config.js")
    const cfg = buildForcedReleaseConfig("patch", REPO_ROOT)
    const idempotent = cfg.plugins.filter(
      (p: unknown) => Array.isArray(p) && String(p[0]).includes("idempotent-npm-publish")
    )
    expect(idempotent).toHaveLength(3)
  })
})

// --- the resolver's decision ----------------------------------------------

// decide() is the function that routes a run down the converge path or the
// ordinary one. It had no test at all: the suite only checked that the
// workflow MENTIONED the file, so sabotaging the decision itself — routing a
// zero-published tag to converge, or swallowing an UNKNOWN answer and
// reporting `release` — left the suite green.
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

  it("routes a partially published tag to converge, naming only what is missing", () => {
    const repo = makeTaggedRepo([`v${V}`])
    const stub = makeStubNpm({ view: { [CP]: "published", [CR]: "missing", [LC]: "missing" } })
    try {
      const result = runDecide(repo, stub.dir)
      expect(result.status).toBe(0)
      const decision = JSON.parse(result.stdout) as { mode: string; missing: string[]; version: string }
      expect(decision.mode).toBe("converge")
      expect(decision.version).toBe(V)
      expect(decision.missing).toEqual(["@pdpp/collector-runtime", "@pdpp/local-collector"])
    } finally {
      stub.cleanup()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // A tag with NOTHING published is not a partial release — converging on it
  // would publish a version from a commit that never got past its first
  // publish. Routing it to converge instead of release is a real behaviour
  // change that the suite previously could not see.
  it("routes a zero-published tag to an ordinary release, not to converge", () => {
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
      const decision = JSON.parse(result.stdout) as { mode: string; version: string }
      expect(decision.mode).toBe("converge")
      // Lexically "v2.9.0" sorts above "v2.10.0"; semantically it does not.
      expect(decision.version).toBe("2.10.0")
    } finally {
      stub.cleanup()
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
