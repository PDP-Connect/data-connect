// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // A fresh dev console compiles owner routes on the first request.
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  outputDir: "test-results",
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:1421",
    trace: "retain-on-failure",
  },
})
