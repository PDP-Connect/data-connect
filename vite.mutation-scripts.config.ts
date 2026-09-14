// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The Vitest configuration the scripts mutation cohort runs under, and the only
// place `scripts/mutation-falsification/test-identity-setup.ts` is registered.
//
// It exists because that setup file rewrites the coverage key Stryker's Vitest
// runner records, and that rewrite is only correct for a run whose reported test
// ids are rewritten to match. `stryker.scripts.config.mjs` does that with
// `testRunner: "vitest-6210"`; `stryker.config.mjs` (client) and the reference
// cohort use the stock `vitest` runner and do not. Registering the setup file in
// the shared `vite.config.ts` would apply the coverage-key rewrite to those
// cohorts too, while their reported ids stayed space-joined -- Stryker's
// `testsById.get(testId)` is an exact-string lookup, so their coverage would no
// longer join and would be discarded. The two halves of the repair are matched
// here, in one configuration, and nowhere else.
//
// Everything else comes from the root configuration by extension, so the test
// inventory this cohort mutates against is the same one `npm test` runs.

import { defineConfig, mergeConfig } from "vitest/config"

import rootConfig from "./vite.config.ts"

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      setupFiles: ["./scripts/mutation-falsification/test-identity-setup.ts"],
    },
  })
)
