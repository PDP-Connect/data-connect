// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { defineConfig, mergeConfig } from "vitest/config"

import rootConfig from "./vite.config.ts"

// Pair with the vitest-6210 runner in stryker.config.mjs. Ordered setup makes
// the identity repair run after Stryker's own coverage hook.
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      setupFiles: ["./scripts/mutation-falsification/test-identity-setup.ts"],
      sequence: { setupFiles: "list" },
    },
  })
)
