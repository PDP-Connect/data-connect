// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { analyzeCommits } from "@semantic-release/commit-analyzer"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"
import { buildForcedReleaseConfig, loadReleaseConfig } from "./forced-release-config.ts"
import { ForcedReleaseRefusal, formatAuditRecord, planForcedRelease } from "./forced-release.ts"

// The forced-release path exists because this repo's scope gate has a silent
// failure mode: a real packaged change under an unscoped `fix:` or a
// `chore:` re-vendor commit resolves no release, so nothing publishes and
// nothing fails. These are the REAL commit subjects that hit it — the two
// connector fixes and the re-vendor commits around them, all merged to
// `main` while @pdpp/local-collector on npm stayed at 2.1.1.
const REAL_UNPUBLISHED_COMMITS = [
  "fix: refresh bundled collectors for malformed source isolation",
  "fix: refresh bundled Codex collector symlink handling",
  "chore: re-vendor connectors at data-connectors#92 merge commit",
  "chore: re-vendor data-connectors at the malformed-line isolation fix",
]

function commitAnalyzerOptions(config: { plugins: unknown[] }) {
  const entry = config.plugins.find(
    plugin => Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer"
  ) as [string, Record<string, unknown>] | undefined
  if (!entry) throw new Error("config has no @semantic-release/commit-analyzer entry")
  return entry[1]
}

async function releaseTypeFor(options: Record<string, unknown>, subjects: string[]) {
  return analyzeCommits(options, {
    commits: subjects.map((message, index) => ({ hash: String(index), message })),
    logger: { log: () => {}, error: () => {} },
    env: {},
    cwd: process.cwd(),
  })
}

describe("forced release publishes what commit analysis refuses", () => {
  // The core assertion this mechanism must satisfy: the exact commits that
  // silently published nothing DO publish when forced.
  it.each(["patch", "minor", "major"] as const)(
    "forcing %s releases the real unscoped commits that the gate refused",
    async releaseType => {
      const forced = commitAnalyzerOptions(buildForcedReleaseConfig(releaseType))
      expect(await releaseTypeFor(forced, REAL_UNPUBLISHED_COMMITS)).toBe(releaseType)
    }
  )

  // Regression guard for the trap documented in .releaserc.yaml's header and
  // reproduced while building this: analyze-commit.js ranks `release: false`
  // above every real release type, so a forced rule PREPENDED to the gate's
  // rules is outranked by its catch-alls. That naive implementation returns
  // null for patch and minor while still working for major — it would look
  // correct in a major-only test and silently publish nothing for the patch
  // case this mechanism was built to serve.
  it("does not leave the gate's release:false catch-alls able to cancel a forced bump", async () => {
    const gated = commitAnalyzerOptions(loadReleaseConfig())
    const naive = {
      ...gated,
      releaseRules: [{ release: "patch" }, ...(gated.releaseRules as unknown[])],
    }
    expect(await releaseTypeFor(naive, REAL_UNPUBLISHED_COMMITS)).toBeNull()

    const forced = commitAnalyzerOptions(buildForcedReleaseConfig("patch"))
    expect(await releaseTypeFor(forced, REAL_UNPUBLISHED_COMMITS)).toBe("patch")
  })

  it("forces a release even with no commits that mention a package at all", async () => {
    const forced = commitAnalyzerOptions(buildForcedReleaseConfig("patch"))
    expect(await releaseTypeFor(forced, ["docs: unrelated", "chore(deps): bump"])).toBe("patch")
  })
})

describe("the ordinary path keeps refusing unscoped commits", () => {
  // The gate must be untouched by this change. Forcing is opt-in per run;
  // an ordinary push must behave exactly as it did before.
  it.each(REAL_UNPUBLISHED_COMMITS)("still releases nothing for %s", async subject => {
    const gated = commitAnalyzerOptions(loadReleaseConfig())
    expect(await releaseTypeFor(gated, [subject])).toBeNull()
  })

  it("still releases nothing for the whole unscoped batch together", async () => {
    const gated = commitAnalyzerOptions(loadReleaseConfig())
    expect(await releaseTypeFor(gated, REAL_UNPUBLISHED_COMMITS)).toBeNull()
  })

  it("still releases a properly scoped commit", async () => {
    const gated = commitAnalyzerOptions(loadReleaseConfig())
    expect(await releaseTypeFor(gated, ["fix(local-collector): resolve packaged import"])).toBe("patch")
  })

  it("building a forced config does not mutate .releaserc.yaml's own rules", async () => {
    const before = JSON.stringify(commitAnalyzerOptions(loadReleaseConfig()).releaseRules)
    buildForcedReleaseConfig("major")
    const after = JSON.stringify(commitAnalyzerOptions(loadReleaseConfig()).releaseRules)
    expect(after).toBe(before)
  })

  // A forced release must ship the same artifacts through the same
  // publishing chain — forcing changes which commits count, nothing else.
  it("keeps every non-analyzer plugin, including all three npm publishes", () => {
    const gated = loadReleaseConfig()
    const forced = buildForcedReleaseConfig("patch")
    const names = (config: { plugins: unknown[] }) =>
      config.plugins.map(plugin => (Array.isArray(plugin) ? plugin[0] : plugin))
    expect(names(forced)).toEqual(names(gated))

    const pkgRoots = forced.plugins
      .filter((plugin): plugin is [string, Record<string, unknown>] =>
        Array.isArray(plugin) && plugin[0] === "@semantic-release/npm"
      )
      .map(([, options]) => options.pkgRoot)
    expect(pkgRoots).toEqual([
      "packages/connector-protocol",
      "packages/collector-runtime",
      "packages/local-collector",
    ])
  })
})

describe("forced-release refusals", () => {
  const valid = { releaseType: "patch", reason: "connector fix merged unscoped", ref: "refs/heads/main" }

  it("refuses a ref that is not main", () => {
    expect(() => planForcedRelease({ ...valid, ref: "refs/heads/some-branch" })).toThrow(
      ForcedReleaseRefusal
    )
    expect(() => planForcedRelease({ ...valid, ref: "refs/tags/v2.2.0" })).toThrow(ForcedReleaseRefusal)
  })

  it.each(["", "  ", undefined as unknown as string])("refuses a missing reason (%j)", reason => {
    expect(() => planForcedRelease({ ...valid, reason })).toThrow(ForcedReleaseRefusal)
  })

  it.each(["", "prerelease", "PATCH", "1.2.3"])("refuses an invalid release_type (%j)", releaseType => {
    expect(() => planForcedRelease({ ...valid, releaseType })).toThrow(ForcedReleaseRefusal)
  })

  it("accepts a valid request and records the audit trail", () => {
    const plan = planForcedRelease({ ...valid, actor: "tnunamak" })
    expect(plan).toMatchObject({ releaseType: "patch", actor: "tnunamak" })

    const record = formatAuditRecord(plan)
    expect(record).toContain("connector fix merged unscoped")
    expect(record).toContain("tnunamak")
    expect(record).toContain("patch")
  })
})

describe("npm-release workflow wiring", () => {
  interface Step {
    name?: string
    run?: string
    env?: Record<string, string>
  }
  interface Workflow {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; options?: string[] }> } }
    jobs: Record<string, { if?: string; steps: Step[]; permissions?: Record<string, string> }>
  }

  const workflow = load(
    readFileSync(resolve(process.cwd(), ".github/workflows/npm-release.yml"), "utf8")
  ) as Workflow

  it("offers release_type and reason as dispatch inputs", () => {
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(inputs.release_type.options).toEqual(["", "patch", "minor", "major"])
    expect(inputs.reason).toBeDefined()
  })

  it("still refuses to run from any ref other than main", () => {
    expect(workflow.jobs["resolve-version"]?.if).toBe("github.ref == 'refs/heads/main'")
  })

  // A forced release must not skip the checks. `quality` still gates
  // `release`, and both still key off the resolved version.
  it("keeps quality gating release on both paths", () => {
    expect(workflow.jobs.quality?.if).toBe(
      "needs.resolve-version.outputs.new-release-published == 'true'"
    )
    expect(workflow.jobs.release?.if).toBe(
      "needs.resolve-version.outputs.new-release-published == 'true'"
    )
  })

  // OIDC trusted publishing must keep working: no NPM_TOKEN, id-token: write.
  it("keeps OIDC trusted publishing on the release job", () => {
    expect(workflow.jobs.release?.permissions?.["id-token"]).toBe("write")
    // Assert on real token USAGE, not any mention: this file's comments
    // legitimately say "no NPM_TOKEN" while describing OIDC.
    const yaml = readFileSync(resolve(process.cwd(), ".github/workflows/npm-release.yml"), "utf8")
    expect(yaml).not.toMatch(/secrets\.NPM_TOKEN/)
  })

  it("routes both the dry run and the publish through the forced path when forcing", () => {
    const publish = workflow.jobs.release?.steps.find(step => step.name === "Run semantic-release")
    expect(publish?.run).toContain("scripts/forced-release.ts")
    // Without a release_type it must still take the ordinary gated path.
    expect(publish?.run).toContain("npm run release:npm")

    const resolveStep = workflow.jobs["resolve-version"]?.steps.find(
      step => step.name === "Determine next version"
    )
    expect(resolveStep?.run).toContain("scripts/forced-release.ts")
    expect(resolveStep?.run).toContain("npm run release:npm:dry-run")
  })
})
