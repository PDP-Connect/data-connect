// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"

import rootConfig from "../../vite.config.ts"

describe("client mutation runner configuration", () => {
  it("pairs corrected test identities with ordered coverage setup", async () => {
    const strykerConfigPath = "../../stryker.config.mjs"
    const { default: strykerConfig } = await import(strykerConfigPath)

    expect(strykerConfig.plugins).toContain(
      "./scripts/mutation-falsification/vitest-runner-plugin.mjs"
    )
    expect(strykerConfig.testRunner).toBe("vitest-6210")
    expect(strykerConfig.vitest.related).not.toBe(false)

    const viteConfigPath = `../../${strykerConfig.vitest.configFile}`
    const { default: viteConfig } = await import(viteConfigPath)
    expect(viteConfig.test.setupFiles).toEqual([
      "./src/test/setup.ts",
      "./scripts/mutation-falsification/test-identity-setup.ts",
    ])
    expect(viteConfig.test.sequence).toMatchObject({ setupFiles: "list" })
    expect(viteConfig.test.include).toEqual(rootConfig.test?.include)
    expect(rootConfig.test?.setupFiles).toEqual(["./src/test/setup.ts"])
  })
})
