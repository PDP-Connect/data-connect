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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
function makeStubNpm(spec: StubSpec): { dir: string; publishLog: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "atomic-npm-"))
  const publishLog = join(dir, "publish.log")
  writeFileSync(publishLog, "")
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
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function readPublishLog(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").map(l => l.trim()).filter(Boolean)
}

// Runs converge-release.ts with a stubbed npm, returning its outcome rather
// than throwing, so a refusal can be asserted on.
function runConverge(
  stubDir: string,
  env: Record<string, string | undefined>
): { status: number; stdout: string; stderr: string } {
  // Resolved rather than hardcoded so the suite runs both against the repo's
  // own install and against an isolated toolchain (this repo's `npm ci` cannot
  // complete in every environment).
  const tsxEntry = require.resolve("tsx")

  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", tsxEntry, join(REPO_ROOT, "scripts/converge-release.ts")],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH ?? ""}`,
          ...env,
        },
      }
    )
    return { status: 0, stdout, stderr: "" }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
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
  it("changes the version and nothing else", async () => {
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

  interface WorkflowJob {
    needs?: string | string[]
    permissions?: Record<string, string>
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
    expect(workflow).toMatch(/mode == 'converge'/)
    expect(workflow).toMatch(/github\.ref == 'refs\/heads\/main'/)
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
