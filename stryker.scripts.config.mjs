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
  // The stock `vitest` runner wrapped by a local plugin. The wrapper exists for
  // one upstream defect: @stryker-mutator/vitest-runner 10.0.0 joins a test's
  // suite chain with a single space to build its coverage keys and its
  // `testNamePattern`, while Vitest 5 matches that pattern against a name
  // joined with " > ". The pattern matches nothing, per-test coverage comes
  // back empty, and every mutant re-runs the whole suite -- which times out.
  // This is stryker-js#6210, open upstream; both packages are already on their
  // latest releases, so there is no version to move to.
  //
  // The repair is two documented extension points, not a patch: this plugin
  // (Stryker's `plugins` + `PluginKind.TestRunner`), which corrects the test
  // ids the runner reports, and `scripts/mutation-test-identity-setup.ts`, a
  // Vitest setup file listed in vite.config.ts, which corrects the coverage
  // keys the sandbox records. Stryker matches the two by exact string, so both
  // halves are load-bearing. Nothing under node_modules is modified.
  plugins: [
    "@stryker-mutator/vitest-runner",
    "./scripts/mutation-vitest-runner-plugin.mjs",
  ],
  testRunner: "vitest-6210",
  // The `scripts/` tests run as part of the root Vitest project -- `test.include`
  // in vite.config.ts lists them explicitly -- so the native runner applies and
  // reports per-test identities, which is what `perTest` analysis needs.
  coverageAnalysis: "perTest",
  // `related: false` is required, not tuning. The runner defaults to Vitest's
  // related mode, which selects test files by following the import graph from
  // the mutated file. This cohort's tests deliberately do not import their
  // targets: npm-release-signer-workflow.test.ts reads
  // `scripts/verify-npm-provenance.ts` as source text through `readFileSync`,
  // and release-atomicity.test.ts reads its workflow the same way. There is no
  // import edge for related mode to follow, so it selects nothing, the dry run
  // reports "No tests were found", and Stryker exits before trying a single
  // mutant -- which is exactly how this cohort came to execute no trials.
  //
  // Selecting the whole root suite instead is affordable only because `perTest`
  // coverage then narrows each mutant to the tests that actually reached it.
  // That narrowing depends on the stryker-js#6210 repair described above the
  // `plugins` entry: without it coverage comes back empty and every mutant
  // re-runs the whole suite, which times out. The two are load-bearing
  // together.
  vitest: { configFile: "vite.config.ts", related: false },

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
