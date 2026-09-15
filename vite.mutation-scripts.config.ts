// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The Vitest configuration the scripts mutation cohort runs under.
//
// `scripts/mutation-falsification/test-identity-setup.ts` rewrites coverage
// keys. That rewrite is only correct when reported test ids are rewritten to
// match. `stryker.scripts.config.mjs` does that with
// `testRunner: "vitest-6210"`; the client pairs the same repair in its own
// `vite.mutation-client.config.ts`. Registering the setup file in
// the shared `vite.config.ts` would also affect runs using the stock runner,
// while their reported ids stayed space-joined -- Stryker's
// `testsById.get(testId)` is an exact-string lookup, so their coverage would no
// longer join and would be discarded. The two halves of the repair are matched
// here and in the client mutation configuration.
//
// Everything else comes from the root configuration by extension, so the test
// inventory this cohort mutates against is the same one `npm test` runs.
//
// `sequence.setupFiles: "list"` is load-bearing, not tidiness. The repair needs
// the runner's own sandbox setup file to be imported before ours: its hook
// writes the space-joined id, ours overwrites it with the corrected one, and
// Vitest runs `beforeEach` hooks in registration order. Registration order is
// import order, and Vitest's default `sequence.setupFiles` is `"parallel"` --
// `runSetupFiles` awaits `Promise.all(files.map(importFile))`
// (vitest/dist/chunks/run.*.js). Under `Promise.all` the file that finishes
// importing first registers first, which is not necessarily the one listed
// first. If ours wins that race, the runner's hook runs second and restores the
// space-joined id: the exact format this repair exists to eliminate, with no
// symptom other than coverage silently failing to join.
//
// `"list"` makes `runSetupFiles` take its sequential branch
// (`for (const fsPath of files) await runner.importFile(fsPath, "setup")`), so
// registration follows the listed order. The runner prepends its own file to
// this array in `init()`, which puts it first in that list.
//
// Set in the mutation configurations rather than in the root configuration:
// only runs that pair the two hooks need this ordering requirement.

import { defineConfig, mergeConfig } from "vitest/config"

import rootConfig from "./vite.config.ts"

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      setupFiles: ["./scripts/mutation-falsification/test-identity-setup.ts"],
      sequence: { setupFiles: "list" },
    },
  })
)
