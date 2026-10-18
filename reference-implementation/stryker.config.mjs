// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Mutation configuration for the reference-implementation cohort.
//
// This cohort runs on `node --test` rather than Vitest, so Stryker drives it
// through the command runner. Three consequences follow, and each is handled
// explicitly rather than left to the tool:
//
//   1. The command runner reports no individual test identities, so per-test
//      coverage analysis is not available and `coverageAnalysis` is "off". Any
//      other setting would claim test-level data the runner cannot supply.
//   2. Because there is no per-test data, test selection has to happen inside
//      the command itself -- Stryker's own `testFiles` option is not supported
//      for this runner and would be silently ignored.
//   3. With no test identities, Stryker's incremental reuse would have its
//      weakest signal exactly where each mutant costs the most, so this cohort
//      carries no result cache and every run is cold.
//
// The reference implementation runs TypeScript sources directly under Node.
// The shared mutation cohort also runs the brand-react popover DOM test, which
// imports TSX and CSS, so tsx and the package's CSS stub are registered here.
// There is no build step to instrument: the sandbox contains the source files.
//
// No duration, budget, mutant-count, or admission threshold appears here.

import { readFileSync } from "node:fs"

// The workflow writes the tests to run for this attempt, one path per line,
// derived from the same diff that produced the mutate list, by
// `run-intent.ts --selected-tests`. A missing or empty file means "no selection
// recorded", and the command runs every test file in the cohort rather than
// quietly narrowing to nothing -- a mutant must never be recorded as surviving a
// selection that was empty.
//
// The fallback is a glob and not a bare `test/` directory: Node resolves a bare
// directory argument as a module rather than expanding it, so `node --test
// test/` fails with MODULE_NOT_FOUND and takes the whole baseline down with it.
// Exported: `run-intent.ts` counts this suite against the attempt bound when no
// test is selected, since it is what every trial would then run.
export const wholeCohortTests = ["test/**/*.test.ts"]

// How much of the test command's output Stryker receives: a quarter of the
// 1 MiB `exec` limit described at `commandRunner` below.
const RETAINED_OUTPUT_BYTES = 256 * 1024

function selectedTestArguments() {
  try {
    const listed = readFileSync("reports/mutation/reference-implementation/selected-tests.txt", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (listed.length > 0) {
      return listed
    }
  } catch {
    // Fall through to the whole-cohort selection below.
  }
  return wholeCohortTests
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "command",
  coverageAnalysis: "off",
  commandRunner: {
    // Test selection lives inside the command, which is the only place this
    // runner can express it. `--test` on explicit paths keeps the selection
    // visible in the retained command string, so a reader of the receipt can
    // see exactly which tests a survivor survived.
    //
    // The output is written to a file and only its tail reaches Stryker. The
    // command runner starts the command with `child_process.exec`, whose
    // default `maxBuffer` is 1 MiB, and when either stream passes that, Node
    // kills the command with SIGTERM. Stryker records that as a failed baseline,
    // or as a kill for a mutant, with no test having failed. The PR #141
    // selection prints about 1.5 MiB on a clean pass, so every baseline was
    // rejected. The tail holds the spec reporter's closing summary, which lists
    // each failing test with its error, and the exit status is kept.
    command:
      `out="$(mktemp)"; ` +
      `TSX_TSCONFIG_PATH=vendor/brand-react/tsconfig.json node --import tsx --import ./vendor/brand-react/css-stub-register.ts --test ${selectedTestArguments().join(" ")} >"$out" 2>&1; ` +
      `status=$?; tail -c ${RETAINED_OUTPUT_BYTES} "$out"; rm -f "$out"; exit "$status"`,
  },

  // Populated from the pull request diff by the workflow; empty means this
  // revision touched no reference-implementation production source.
  mutate: [],

  // One trial at a time. Each trial is itself parallel: `node --test` starts a
  // process per test file, and tsx compiles in each, so one trial of the 7-file
  // sample on PR #494 used about 12 CPU-seconds in 3.3 s of wall time and fills
  // a 4-CPU runner on its own. Stryker's timeout is `1.5 * net dry-run time +
  // 5 s`, and the dry run runs alone. With four Stryker workers each trial then
  // competes with three others and takes about four times as long, so any
  // selection whose solo run passes 2 s outlives that limit: every one of the 144
  // mutants of PR #494 timed out and the attempt had no evidence. One worker
  // makes a trial run under the conditions the limit was measured in. It is not
  // slower: 18 mutants took 43 s with one worker and 52 s with four.
  concurrency: 1,

  reporters: ["json", "html", "progress"],
  jsonReporter: { fileName: "reports/mutation/reference-implementation/mutation.json" },
  htmlReporter: { fileName: "reports/mutation/reference-implementation/mutation.html" },

  inPlace: false,
  checkers: [],

  // No `// @ts-nocheck` rewriting. Nothing in this cohort type-checks: tsx
  // strips types without checking them and `checkers` is empty, so the header
  // protects nothing here. Its cost is real. Stryker's default pattern rewrites
  // every JavaScript and TypeScript file under `test/`, `src/` and `lib/`, mutated
  // or not, and a rewritten file is written fresh rather than copied, which
  // drops its mode. `test/fixtures/legacy-profiles/slack/slackdump-stub.mjs` is
  // executed directly as `SLACKDUMP_BIN`; without its executable bit both
  // compiled-Slack tests failed in the PR #141 baseline. With this off, an
  // unmutated file is copied byte-for-byte with its mode.
  disableTypeChecks: false,

  // Stryker copies the working tree into the sandbox, so anything not needed to
  // run this cohort's tests is excluded. `node_modules` is deliberately absent
  // from this list: the tests import from it, and Stryker links it into the
  // sandbox rather than copying it.
  //
  // `quality` is checked-in report output that no test or script in this cohort
  // reads, so it is copied into every sandbox for nothing. Measured, it is worth
  // 2.9 MB of a 46 MB sandbox -- real, but small: the disk exhaustion that
  // failed a hosted run of this cohort after 91 minutes came from the mutant
  // count, not the copied tree, and is addressed by scoping mutation to the
  // changed lines rather than by this list. Stated so the next reader does not
  // over-credit it. `connectors`, `examples` and `openapi` are deliberately NOT
  // excluded: tests read them. `openapi` used to be listed, and
  // `test/owner-connection-intent.test.ts` reads
  // `openapi/reference-full.openapi.json`, so it failed with ENOENT in the
  // PR #141 baseline. `docs` above is a pre-existing entry, and ~65 cohort files
  // do reference `docs/` -- worth revisiting separately, not changed here.
  ignorePatterns: ["reports", "fixtures/large", "vendor/*/dist", "docs", "quality"],

  tempDirName: ".stryker-tmp/reference-implementation",
}
