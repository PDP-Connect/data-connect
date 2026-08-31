// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("tauri manual-install config", () => {
  it("bundles the target-native Node runtime as a Tauri sidecar", () => {
    const filePath = resolve(process.cwd(), "src-tauri/tauri.conf.json")
    const document = JSON.parse(readFileSync(filePath, "utf-8")) as {
      bundle?: {
        externalBin?: string[]
        resources?: Record<string, string>
      }
    }

    expect(document.bundle?.externalBin).toEqual(["binaries/pdpp-node"])
    expect(document.bundle?.resources?.["binaries/pdpp-node-LICENSE"]).toBe(
      "licenses/pdpp-node-LICENSE"
    )
  })

  it("preserves the packaged Playwright browser directory tree", () => {
    const filePath = resolve(process.cwd(), "src-tauri/tauri.conf.json")
    const document = JSON.parse(readFileSync(filePath, "utf-8")) as {
      bundle?: { resources?: Record<string, string> }
    }

    expect(document.bundle?.resources?.["../playwright-runner/dist/"]).toBe(
      "playwright-runner/dist/"
    )
    expect(
      document.bundle?.resources?.["../playwright-runner/dist/**/*"]
    ).toBeUndefined()
  })

  it("preserves the packaged PDPP runtime directory tree", () => {
    const filePath = resolve(process.cwd(), "src-tauri/tauri.conf.json")
    const document = JSON.parse(readFileSync(filePath, "utf-8")) as {
      bundle?: { resources?: Record<string, string> }
    }

    expect(document.bundle?.resources?.["../pdpp-runtime/"]).toBe(
      "pdpp-runtime/"
    )
    expect(document.bundle?.resources?.["../pdpp-runtime/**/*"]).toBeUndefined()
  })

  it("bundles the pinned GitHub and ChatGPT PDPP profiles", () => {
    const filePath = resolve(process.cwd(), "src-tauri/tauri.conf.json")
    const document = JSON.parse(readFileSync(filePath, "utf-8")) as {
      bundle?: { resources?: Record<string, string> }
    }

    expect(
      document.bundle?.resources?.["../connectors/collection-profiles/"]
    ).toBe("connectors/collection-profiles/")
    expect(
      document.bundle?.resources?.["../connectors/collection-profiles/**/*"]
    ).toBeUndefined()
    expect(document.bundle?.resources?.["../connectors/lock.json"]).toBe(
      "connectors/lock.json"
    )
  })

  it("stages PDPP runtime dependencies before production Tauri packaging", () => {
    const filePath = resolve(process.cwd(), "src-tauri/tauri.conf.json")
    const document = JSON.parse(readFileSync(filePath, "utf-8")) as {
      build?: { beforeBuildCommand?: string }
    }

    expect(document.build?.beforeBuildCommand).toContain(
      "node scripts/ensure-pdpp-runtime.js"
    )
  })

  it("disables updater artifacts and ships no updater endpoint", () => {
    const filePath = resolve(process.cwd(), "src-tauri/tauri.conf.json")
    const document = JSON.parse(readFileSync(filePath, "utf-8")) as {
      bundle?: { createUpdaterArtifacts?: boolean }
      plugins?: {
        updater?: unknown
      }
    }

    expect(document.bundle?.createUpdaterArtifacts).toBe(false)
    expect(document.plugins?.updater).toBeUndefined()
  })

  it("has no active Vana service or update endpoint in shipped defaults", () => {
    const defaultConfigPaths = [
      "src-tauri/tauri.conf.json",
      ".env.prod.example",
      ".env.example",
      ".env.dev.example",
    ]

    for (const relativePath of defaultConfigPaths) {
      const contents = readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
      )
      expect(contents).not.toMatch(/https?:\/\/[^\s"']*vana\.(?:com|org)/i)
    }
  })

  it("has no hard-coded Vana protocol service in default runtime paths", () => {
    const runtimePaths = [
      "src/services/accountApi.ts",
      "src/services/builder.ts",
      "src/services/serverRegistration.ts",
      "src/services/sessionRelay.ts",
      "src/services/vanaSession.ts",
      "src-tauri/src/commands/server.rs",
      "personal-server/index.js",
      "personal-server/index.cjs",
    ]

    for (const relativePath of runtimePaths) {
      const contents = readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
      )
      expect(contents).not.toMatch(
        /(?:session-relay|data-gateway|account|hydra|frpc\.server|server)\S*\.vana\.org/i
      )
    }
  })
})
