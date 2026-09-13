// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import { execSync } from "child_process"
import path from "path"
import tailwindcss from "@tailwindcss/vite"

// Get git commit hash
const commitHash = execSync("git rev-parse --short HEAD").toString().trim()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "happy-dom",
    include: [
      "src/**/*.test.{ts,tsx}",
      "src-tauri/**/*.test.ts",
      "scripts/is-main-module.test.mjs",
      "scripts/create-macos-dmg.test.mjs",
      "scripts/ensure-pdpp-runtime.test.mjs",
      "scripts/release-github.test.mjs",
      "scripts/release-workflow.test.ts",
      "scripts/mutation-test-identity.test.ts",
      "scripts/mutation-falsification/*.test.ts",
      "scripts/npm-release-commit-analyzer.test.ts",
      "scripts/npm-release-signer-workflow.test.ts",
      "scripts/forced-release.test.ts",
      "scripts/release-atomicity.test.ts",
      "scripts/stage-pdpp-node.test.mjs",
      "scripts/resolve-connectors.test.mjs",
      "scripts/verify-release-ref.test.mjs",
      "scripts/verify-bundled-personal-server.test.mjs",
      "playwright-runner/scripts/build.test.js",
    ],
    // The second file reconciles the test identity Stryker's Vitest runner
    // records with the one Vitest 5 filters on (stryker-js#6210). It is inert
    // outside a mutation run. It must stay last: Stryker prepends its own
    // sandbox setup file, and this one has to overwrite what that one wrote.
    setupFiles: [
      "./src/test/setup.ts",
      "./scripts/mutation-test-identity-setup.ts",
    ],
  },
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
})
