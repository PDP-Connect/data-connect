// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:1421",
    trace: "retain-on-failure",
  },
})
