// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { analyzeCommits } from "@semantic-release/commit-analyzer"
import { load } from "js-yaml"
// The REAL loader semantic-release runs, not a stand-in. Every "the forced
// path publishes" assertion below goes through this, because the defect this
// suite failed to catch lived entirely in the loader's merge order and was
// invisible to any test that inspected the config object directly.
import getConfig from "semantic-release/lib/get-config.js"
import { describe, expect, it } from "vitest"
import { buildForcedReleaseConfig, loadReleaseConfig } from "./forced-release-config.ts"
import {
  buildForcedReleaseOptions,
  ForcedReleaseRefusal,
  formatAuditRecord,
  planForcedRelease,
} from "./forced-release.ts"

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

// ---------------------------------------------------------------------------
// Resolution through the REAL semantic-release config loader.
//
// This block exists because the suite it joins could not see a fatal defect:
// the forced config was handed to semantic-release with `--extends`, and
// lib/get-config.js computes `{...configFile, ...cliOptions}` and then
// `{...extendsOptions, ...options}` — so an EXTENDED config sits UNDERNEATH
// the repository's own .releaserc.yaml. With .releaserc.yaml present, which
// is every CI run, a forced dispatch resolved the gated rules, published
// nothing, and printed an audit record claiming the gate had been bypassed.
// Every pre-existing "forced path publishes" test passed throughout, because
// all of them called analyzeCommits on the builder's return value and nothing
// went through the loader.
//
// So: resolve the way semantic-release resolves, then assert on the rules
// that actually come out.
// ---------------------------------------------------------------------------
const REPO_ROOT = process.cwd()

function silentContext(cwd: string) {
  const noop = () => {}
  const logger = { log: noop, error: noop, warn: noop, success: noop, scope: () => logger }
  return { cwd, env: process.env, stdout: process.stdout, stderr: process.stderr, logger }
}

/** The commit-analyzer releaseRules semantic-release ACTUALLY resolves. */
async function resolvedReleaseRules(
  cliOptions: Record<string, unknown>,
  cwd: string = REPO_ROOT
): Promise<unknown> {
  const { options } = (await getConfig(silentContext(cwd), cliOptions)) as {
    options: { plugins: unknown[] }
  }
  const entry = options.plugins.find(
    plugin => Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer"
  ) as [string, Record<string, unknown>] | undefined
  if (!entry) throw new Error("resolved config has no @semantic-release/commit-analyzer entry")
  return entry[1].releaseRules
}

describe("the forced config survives semantic-release's config loader", () => {
  const plan = { releaseType: "patch" as const, reason: "connector fix merged unscoped", actor: "ci", dryRun: false }

  // THE regression test for the fatal defect. It runs from the repo root, so
  // cosmiconfig finds the real .releaserc.yaml exactly as it does in CI. If
  // the forced options ever stop overriding that file, the resolved rules
  // become the gated seven and this fails.
  it("resolves the unconditional forced rule, not the gate, with .releaserc.yaml present", async () => {
    expect(await resolvedReleaseRules(buildForcedReleaseOptions(plan))).toEqual([{ release: "patch" }])
  })

  it.each(["patch", "minor", "major"] as const)(
    "resolves a forced %s bump through the loader",
    async releaseType => {
      const rules = await resolvedReleaseRules(buildForcedReleaseOptions({ ...plan, releaseType }))
      expect(rules).toEqual([{ release: releaseType }])
    }
  )

  // The resolved rules must not merely LOOK right — they must actually
  // release the commits that silently published nothing. This closes the
  // loop from loader output to release decision.
  it.each(["patch", "minor", "major"] as const)(
    "the loader-resolved forced %s config releases the real unscoped commits",
    async releaseType => {
      const { options } = (await getConfig(
        silentContext(REPO_ROOT),
        buildForcedReleaseOptions({ ...plan, releaseType })
      )) as { options: { plugins: unknown[] } }
      const analyzer = options.plugins.find(
        plugin => Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer"
      ) as [string, Record<string, unknown>]
      expect(await releaseTypeFor(analyzer[1], REAL_UNPUBLISHED_COMMITS)).toBe(releaseType)
    }
  )

  // Pins the exact mistake that was shipped: the same forced config passed as
  // `extends` resolves the GATE, because an extended config loses to
  // .releaserc.yaml. Keeping this as an executable assertion means a future
  // change back to `--extends` fails here with the reason attached, rather
  // than passing every test and publishing nothing.
  it("would resolve the gate instead if the forced config were passed via extends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forced-release-extends-"))
    const configPath = join(dir, "forced-release.json")
    writeFileSync(configPath, JSON.stringify(buildForcedReleaseConfig("patch"), null, 2))

    const viaExtends = (await resolvedReleaseRules({ extends: configPath })) as unknown[]
    expect(viaExtends).not.toEqual([{ release: "patch" }])
    expect(viaExtends).toEqual(loadReleaseConfig().plugins.flatMap(plugin =>
      Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer"
        ? [plugin[1].releaseRules]
        : []
    )[0])
    // And those gated rules are exactly the ones that refuse the commits a
    // forced release exists to publish.
    expect(await releaseTypeFor({ preset: "conventionalcommits", releaseRules: viaExtends }, REAL_UNPUBLISHED_COMMITS)).toBeNull()
  })

  // The ordinary path must still resolve the gate through the same loader.
  it("leaves an unforced run resolving .releaserc.yaml's gated rules", async () => {
    const gated = await resolvedReleaseRules({})
    expect(await releaseTypeFor({ preset: "conventionalcommits", releaseRules: gated as unknown[] }, REAL_UNPUBLISHED_COMMITS)).toBeNull()
    expect(
      await releaseTypeFor({ preset: "conventionalcommits", releaseRules: gated as unknown[] }, [
        "fix(local-collector): resolve packaged import",
      ])
    ).toBe("patch")
  })

  // Forcing changes which commits count as releasable and nothing else: the
  // resolved plugin chain must still be the full publish chain.
  it("resolves the same plugin chain an ordinary release uses", async () => {
    const forced = (await getConfig(silentContext(REPO_ROOT), buildForcedReleaseOptions(plan))) as {
      options: { plugins: unknown[] }
    }
    const ordinary = (await getConfig(silentContext(REPO_ROOT), {})) as {
      options: { plugins: unknown[] }
    }
    const names = (plugins: unknown[]) =>
      plugins.map(plugin => (Array.isArray(plugin) ? plugin[0] : plugin))
    expect(names(forced.options.plugins)).toEqual(names(ordinary.options.plugins))
  })

  it("carries the dry-run flags through as API options", () => {
    expect(buildForcedReleaseOptions({ ...plan, dryRun: true })).toMatchObject({ dryRun: true, ci: false })
    expect(buildForcedReleaseOptions(plan)).not.toHaveProperty("dryRun")
  })
})

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

  // An ABSENT ref is refused as hard as a wrong one. Anything running on a
  // runner sets GITHUB_REF, so the only caller that gets here without one is
  // a developer shell — which previously sailed past this guard entirely and
  // was stopped only by semantic-release's own branch check, a layer deeper
  // than this script claims to hold.
  it("refuses a request with no ref at all", () => {
    expect(() => planForcedRelease({ ...valid, ref: undefined })).toThrow(ForcedReleaseRefusal)
    expect(() => planForcedRelease({ ...valid, ref: undefined })).toThrow(/no ref/i)
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
    on: {
      workflow_dispatch: {
        inputs: Record<string, { type: string; options?: string[]; default?: string }>
      }
    }
    jobs: Record<
      string,
      { if?: string; needs?: string | string[]; steps: Step[]; permissions?: Record<string, string> }
    >
  }

  const workflow = load(
    readFileSync(resolve(process.cwd(), ".github/workflows/npm-release.yml"), "utf8")
  ) as Workflow

  // The opt-out is a `none` sentinel, not an empty string: an empty choice
  // option is invalid workflow syntax and GitHub validates it inconsistently.
  it("offers release_type and reason as dispatch inputs, with a none sentinel", () => {
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(inputs.release_type.options).toEqual(["none", "patch", "minor", "major"])
    expect(inputs.release_type.options).not.toContain("")
    expect(inputs.release_type.default).toBe("none")
    expect(inputs.reason).toBeDefined()
  })

  // `none` and the empty string a `push` event produces must BOTH take the
  // ordinary path. Asserting the guard text keeps the sentinel and the shell
  // condition from drifting apart — a `-n "$RELEASE_TYPE"` test alone would
  // treat "none" as a request to force and hand it to a script that refuses
  // it as an invalid release type.
  it.each(["Determine next version", "Run semantic-release"])(
    "treats the none sentinel as not forcing in %s",
    stepName => {
      const step = [
        ...(workflow.jobs["resolve-version"]?.steps ?? []),
        ...(workflow.jobs.release?.steps ?? []),
      ].find(candidate => candidate.name === stepName)
      expect(step?.run).toContain('[ "$RELEASE_TYPE" != "none" ]')
      expect(step?.run).toContain('[ -n "$RELEASE_TYPE" ]')
    }
  )

  // The resume path added `&& inputs.resume != true` here (a resume skips
  // version resolution entirely), so this asserts the main-only clause rather
  // than the whole string — the claim this test owns is the ref gate, and an
  // exact-string match would break on any unrelated condition added beside it.
  it("still refuses to run from any ref other than main", () => {
    expect(workflow.jobs["resolve-version"]?.if).toContain("github.ref == 'refs/heads/main'")
  })

  // A forced release must not skip the checks. `quality` still gates
  // `release`, and both still key off the resolved version.
  //
  // The `needs` assertion is not redundant with the `if` ones: dropping
  // `quality` from `release.needs` leaves both `if:` strings untouched, so an
  // earlier version of this test passed while `release` no longer waited on
  // the quality job at all. Asserting the dependency edge itself is what
  // makes "quality gates release" a claim this test can actually falsify.
  it("keeps quality gating release on both paths", () => {
    // `quality` now also runs on the resume path, where resolve-version is
    // skipped, so its condition is a disjunction rather than one string. What
    // this test still owns is that the ORDINARY (and forced) path cannot
    // reach quality without a resolved version — asserted as a clause here,
    // and exactly as before for `release`, which the resume path never uses.
    expect(workflow.jobs.quality?.if).toContain(
      "needs.resolve-version.outputs.new-release-published == 'true'"
    )
    expect(workflow.jobs.release?.if).toBe(
      "needs.resolve-version.outputs.new-release-published == 'true'"
    )

    expect(workflow.jobs.quality?.needs).toBe("resolve-version")
    const releaseNeeds = workflow.jobs.release?.needs
    expect(Array.isArray(releaseNeeds) ? releaseNeeds : [releaseNeeds]).toEqual(
      expect.arrayContaining(["resolve-version", "quality"])
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
