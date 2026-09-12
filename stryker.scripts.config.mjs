// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Mutation configuration for the scripts cohort (scripts/, run by Vitest).
//
// This cohort exists because the release and supply-chain provenance machinery
// lives under `scripts/` and was reached by neither of the other two: the client
// cohort selects `src/` and the reference-implementation cohort selects paths
// under `reference-implementation/`. A test asserting on a script's source text
// rather than its behaviour therefore passed unchallenged for as long as it
// existed, because nothing ever mutated the script underneath it.
//
// Its root is the repository root, the same as the client cohort's. That is not
// a convenience: the `scripts/` tests resolve their fixtures from
// `process.cwd()` (`resolve(process.cwd(), ".github/workflows/npm-release.yml")`
// in npm-release-signer-workflow.test.ts, and the same shape in
// release-atomicity.test.ts), and several read repository-root paths outside
// `scripts/` altogether. A cohort rooted at `scripts/` would sandbox away the
// very files those tests read, failing the initial test run and making every
// mutant in the batch inconclusive.
//
// The configuration is a separate file rather than a flag on the client
// configuration because `jsonReporter.fileName` has to differ: the workflow
// reads each cohort's report from a cohort-named path, and two cohorts sharing
// a root would otherwise overwrite each other's observations.
//
// No duration, budget, mutant-count, or admission threshold appears here. Scope
// is whatever the revision touched.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // The `scripts/` tests run as part of the root Vitest project -- `test.include`
  // in vite.config.ts lists them explicitly -- so the native runner applies and
  // reports per-test identities, which is what `perTest` analysis needs.
  coverageAnalysis: "perTest",
  vitest: { configFile: "vite.config.ts" },

  // Populated from the pull request diff by the workflow; empty means this
  // revision touched no scripts production source.
  mutate: [],

  reporters: ["json", "html", "progress"],
  jsonReporter: { fileName: "reports/mutation/scripts/mutation.json" },
  htmlReporter: { fileName: "reports/mutation/scripts/mutation.html" },

  inPlace: false,

  // Matches the client cohort's exclusions: the sandbox is a copy of the working
  // tree, and nothing here is read by a `scripts/` test. The last three entries
  // are the same developer-machine EISDIR workaround the client configuration
  // documents -- those directories hold local tooling whose entries can be
  // symlinks to directories, and they do not exist on CI.
  ignorePatterns: [
    "reference-implementation",
    "src-tauri/target",
    "packages/*/dist",
    "reports",
    "dist",
    ".agents",
    ".cursor",
    ".claude",
  ],

  checkers: [],

  tempDirName: ".stryker-tmp/scripts",
}
