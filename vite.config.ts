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
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      ...(mode === "legacy"
        ? {
            "@tauri-apps/api/core": path.resolve(
              __dirname,
              "./src/legacy-harness/mock-tauri.ts"
            ),
            "@tauri-apps/api/event": path.resolve(
              __dirname,
              "./src/legacy-harness/mock-tauri.ts"
            ),
            "@tauri-apps/api/app": path.resolve(
              __dirname,
              "./src/legacy-harness/mock-tauri.ts"
            ),
            "@tauri-apps/plugin-http": path.resolve(
              __dirname,
              "./src/legacy-harness/mock-tauri.ts"
            ),
            "@tauri-apps/plugin-shell": path.resolve(
              __dirname,
              "./src/legacy-harness/mock-tauri.ts"
            ),
            "@tauri-apps/plugin-clipboard-manager": path.resolve(
              __dirname,
              "./src/legacy-harness/mock-tauri.ts"
            ),
          }
        : {}),
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
      "scripts/mutation-falsification/*.test.ts",
      "scripts/check-dockerfile-copy-paths.test.ts",
      "scripts/check-flyio-deploy-env.test.ts",
      "scripts/check-railway-deploy-env.test.ts",
      "scripts/check-railway-ghcr-public.test.ts",
      "scripts/check-railway-template-artifacts.test.ts",
      "scripts/npm-release-commit-analyzer.test.ts",
      "scripts/npm-release-signer-workflow.test.ts",
      "scripts/core-headed-patchright-runtime-oracle.test.ts",
      "scripts/docker-core-first-boot.test.ts",
      "scripts/forced-release.test.ts",
      "scripts/release-atomicity.test.ts",
      "scripts/railway-mcp-query-smoke.test.ts",
      "scripts/stage-pdpp-node.test.mjs",
      "scripts/ensure-reference-stack.test.js",
      "scripts/ensure-console-stack.test.js",
      "scripts/stage-generations.test.js",
      "scripts/resolve-connectors.test.mjs",
      "scripts/verify-release-ref.test.mjs",
      "scripts/verify-bundled-personal-server.test.mjs",
      "scripts/consumer-drift-signal.test.mjs",
      "scripts/check-polyfill-connectors-tarball-freshness.test.mjs",
      "playwright-runner/scripts/build.test.js",
    ],
    exclude: ["src-tauri/target/**"],
    setupFiles: ["./src/test/setup.ts"],
  },
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
}))
