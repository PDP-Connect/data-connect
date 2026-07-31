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
      "scripts/release-workflow.test.ts",
      "scripts/resolve-connectors.test.mjs",
      "scripts/verify-release-ref.test.mjs",
      "scripts/verify-bundled-personal-server.test.mjs",
      "playwright-runner/scripts/build.test.js",
    ],
    setupFiles: ["./src/test/setup.ts"],
  },
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
})
