// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { analyzeCommits } from "@semantic-release/commit-analyzer"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"

// This repo's .releaserc.yaml gates npm releases to commits scoped to one of
// the lockstep packages it publishes, because (unlike
// PDP-Connect/pdpp, whose config this repo's is based on) this repo also has
// an entirely separate desktop-app commit history that must never trigger an
// npm publish. @semantic-release/commit-analyzer has no built-in "require
// this scope" option and its string `scope` rules match with micromatch glob
// syntax, not regex, so the gate is a releaseRules glob allowlist — see the
// comment block at the top of .releaserc.yaml for the full reasoning,
// including a real bug this test guards against: a naive single catch-all
// `{ release: false }` rule does not mean "everything else releases
// nothing" — analyze-commit.js's priority comparator ranks `false` above
// every real release type, so one unrelated commit in the same release batch
// silently cancels a real one. These tests exercise the actual installed
// @semantic-release/commit-analyzer against this repo's real .releaserc.yaml,
// not a hand-written reimplementation of its matching logic.

function loadCommitAnalyzerConfig() {
  const releaserc = load(readFileSync(resolve(process.cwd(), ".releaserc.yaml"), "utf8")) as {
    plugins: unknown[]
  }
  const entry = releaserc.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer"
  ) as [string, Record<string, unknown>] | undefined
  if (!entry) {
    throw new Error(".releaserc.yaml has no @semantic-release/commit-analyzer entry")
  }
  return entry[1]
}

async function releaseTypeFor(subjects: string[]) {
  const commits = subjects.map((message, index) => ({ hash: String(index), message }))
  const context = {
    commits,
    logger: { log: () => {}, error: () => {} },
    env: {},
    cwd: process.cwd(),
  }
  return analyzeCommits(loadCommitAnalyzerConfig(), context)
}

describe(".releaserc.yaml commit-analyzer scope gate", () => {
  it.each([
    ["fix(collector-runtime): remove dep", "patch"],
    ["feat(connector-protocol): add thing", "minor"],
    ["perf(collector-runtime): faster hashing", "patch"],
    ["fix(collector-runtime,connector-protocol,local-collector): multi-package commit", "patch"],
    ["feat(collector-runtime)!: require explicit executionRoot", "major"],
    // @pdpp/local-collector joined this publish set when release
    // responsibility for it moved here from PDP-Connect/pdpp. Its commits
    // must cut releases now; before that, a fix(local-collector) commit
    // released nothing and the packaging fix reached no user.
    ["fix(local-collector): resolve packaged import", "patch"],
    ["feat(local-collector): add connector", "minor"],
    ["perf(local-collector): faster scan", "patch"],
    // @pdpp/cli, @pdpp/read-core and @pdpp/mcp-server joined when their
    // publishing moved here from PDP-Connect/pdpp.
    ["fix(cli): exit 3 on a revoked token", "patch"],
    ["feat(read-core): add field window", "minor"],
    ["perf(mcp-server): cache schema", "patch"],
    ["fix(auth,cli): answer revoked tokens with 401", "patch"],
    ["fix(auth,cli,docs): a package only in the middle of the scope list", "patch"],
    ["revert(cli): drop the token refresh", "patch"],
    ["feat(mcp-server)!: require grant_id", "major"],
  ])("releases %s as a %s bump", async (subject, expected) => {
    expect(await releaseTypeFor([subject])).toBe(expected)
  })

  it.each([
    ["fix(polyfill-connectors): something", "scoped, but not a published package"],
    ["ci(drift-signal): close gaps", "scoped, but not a published package"],
    ["docs(local-collector): correct claim", "scoped, but not a published package"],
    ["refactor(polyfill-connectors): tidy", "scoped, but not a published package"],
    ["chore(deps): bump", "unscoped"],
    ["feat: add heb and whole foods connectors", "unscoped feat — real prior commit shape in this repo's history"],
    ["fix: harden packaged connector runtime", "unscoped fix — real prior commit shape in this repo's history"],
    ["revert: revert something", "unscoped revert"],
    // A scope that only starts or ends like a package name is another scope.
    ["fix(client): retry", "scoped, but `client` is not `cli`"],
    ["fix(cli-docs): typo", "scoped, but `cli-docs` is not `cli`"],
    ["feat(mcp): add tool", "scoped, but `mcp` is not `mcp-server`"],
    ["fix(read-core-tests): flake", "scoped, but not a published package"],
  ])("does not release on %s (%s)", async (subject) => {
    expect(await releaseTypeFor([subject])).toBeNull()
  })

  // The no-release rule is hand-written as the negation of SCOPE_GLOB. If the
  // two drift, a package scope can match both a release rule and the `false`
  // rule, which cancels the batch, or neither, which falls through to the
  // preset's default rules.
  it("keeps the no-release scope rule the exact negation of the package scope glob", () => {
    const rules = loadCommitAnalyzerConfig().releaseRules as { scope?: unknown; release?: unknown; type?: unknown }[]
    const packageScopes = new Set(rules.filter((rule) => rule.release !== false).map((rule) => rule.scope))
    expect(packageScopes.size).toBe(1)
    const [glob] = packageScopes
    expect(rules.filter((rule) => rule.release === false && typeof rule.scope === "string")).toEqual([
      { release: false, scope: `!(${glob})` },
    ])
  })

  it("a real target-package fix is not cancelled by an unrelated commit in the same batch", async () => {
    const result = await releaseTypeFor(["fix(collector-runtime): remove dep", "fix(polyfill-connectors): unrelated"])
    expect(result).toBe("patch")
  })

  it("a batch with no target-package commits releases nothing, even mixing scoped and unscoped", async () => {
    const result = await releaseTypeFor(["fix(polyfill-connectors): unrelated 1", "feat: unscoped desktop feature"])
    expect(result).toBeNull()
  })

  it("picks the higher of two target-package release types in the same batch", async () => {
    const result = await releaseTypeFor(["feat(collector-runtime): add feature", "fix(connector-protocol): patch level fix"])
    expect(result).toBe("minor")
  })

  it("a target-package fix is not cancelled by an unrelated breaking change in the same batch", async () => {
    const result = await releaseTypeFor(["fix(collector-runtime): small fix", "feat(polyfill-connectors)!: breaking unrelated change"])
    expect(result).toBe("patch")
  })
})
