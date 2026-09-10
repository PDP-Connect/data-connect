// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Mutation configuration for the client cohort (src/, run by Vitest).
//
// `mutate` is deliberately empty here. Stryker has no changed-files selection
// of its own, so the workflow derives the file list from the pull request's
// merge-base..head diff and passes it on the command line. Running this config
// with no `--mutate` therefore mutates nothing, which is the correct behaviour
// for a revision that touched no client production source.
//
// No duration, budget, mutant-count, or admission threshold appears in this
// file. Scope is whatever the revision touched, and that scope is the only
// thing controlling cost -- there is no result cache.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // The client suite is a Vitest project, so the native runner applies: it
  // reports per-test identities, which is what lets `perTest` coverage analysis
  // work on real test-level data rather than guesses.
  coverageAnalysis: "perTest",
  vitest: { configFile: "vite.config.ts" },

  mutate: [],

  // `json` is the mutation-testing-elements report the evidence adapter reads
  // as an observation artifact; `html` is for a human reading the PR artifact.
  // Nothing is published to a third-party dashboard.
  reporters: ["json", "html", "progress"],
  jsonReporter: { fileName: "reports/mutation/client/mutation.json" },
  htmlReporter: { fileName: "reports/mutation/client/mutation.html" },

  // Leave the checked-out tree alone: mutants are applied inside a sandbox.
  inPlace: false,

  // Stryker copies the working tree into that sandbox, so anything the client
  // suite does not need to run is excluded, keeping the copy proportional to
  // the cohort.
  //
  // The last three entries are a developer-machine workaround, stated plainly
  // rather than dressed up as scoping: these directories hold local tooling
  // whose entries can be symlinks to directories, and the sandbox copy fails
  // with EISDIR when it meets one. They do not exist on CI. No client test
  // reads them either way, so excluding them costs nothing.
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

  // Type checking each mutant is a separate concern from asking whether the
  // suite detects a fault, and the repository typechecks the real tree anyway.
  checkers: [],

  tempDirName: ".stryker-tmp/client",
}
