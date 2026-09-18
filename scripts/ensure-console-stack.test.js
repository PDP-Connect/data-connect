// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseArgs, stageConsoleStack } from "./ensure-console-stack.js"

function createConsoleBuildFixture() {
  const root = mkdtempSync(join(tmpdir(), "pdpp-console-stack-"))
  const standalone = join(
    root,
    "apps",
    "console",
    ".next",
    "standalone",
    "apps",
    "console"
  )
  mkdirSync(join(standalone, ".next"), { recursive: true })
  mkdirSync(join(root, "apps", "console", ".next", "static"), {
    recursive: true,
  })
  mkdirSync(join(root, "apps", "console", "public"), { recursive: true })
  writeFileSync(join(standalone, "server.js"), "generated server")
  writeFileSync(join(standalone, "package.json"), "{}\n")
  writeFileSync(
    join(root, "apps", "console", ".next", "static", "app.js"),
    "static"
  )
  writeFileSync(
    join(root, "apps", "console", "public", "favicon.svg"),
    "public"
  )
  const manifestsDirectory = join(
    root,
    "node_modules",
    "@pdpp",
    "polyfill-connectors",
    "manifests"
  )
  mkdirSync(manifestsDirectory, { recursive: true })
  writeFileSync(join(manifestsDirectory, "ynab.json"), "{}")
  writeFileSync(
    join(root, "node_modules", "@pdpp", "polyfill-connectors", "package.json"),
    "{}\n"
  )
  return root
}

describe("ensure console stack", () => {
  it("parses and validates a Tauri profile", () => {
    expect(parseArgs(["--profile", "debug"], {})).toEqual({ profile: "debug" })
    expect(() => parseArgs(["--profile", "../release"], {})).toThrow(
      /invalid Tauri profile/
    )
  })

  it("builds the console through its workspace script and stages the complete runtime tree", () => {
    const root = createConsoleBuildFixture()
    const calls = []
    try {
      const result = stageConsoleStack({
        build: true,
        env: { CI: "1" },
        profile: "release",
        projectRoot: root,
        spawn: (...args) => {
          calls.push(args)
          return { status: 0 }
        },
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual([
        "npm",
        ["run", "build", "--workspace=apps/console"],
        expect.objectContaining({
          cwd: root,
          env: { CI: "1", NODE_ENV: "production" },
          shell: false,
          stdio: "inherit",
        }),
      ])
      expect(
        readFileSync(
          join(result.stageDirectory, "apps/console/server.js"),
          "utf8"
        )
      ).toBe("generated server")
      expect(
        readFileSync(
          join(result.stageDirectory, "apps/console/.next/static/app.js"),
          "utf8"
        )
      ).toBe("static")
      expect(
        readFileSync(
          join(result.stageDirectory, "apps/console/public/favicon.svg"),
          "utf8"
        )
      ).toBe("public")
      expect(
        readFileSync(join(result.stageDirectory, "launch.mjs"), "utf8")
      ).toContain('resolve(stageDirectory, "apps/console/server.js")')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("stages the connector manifests package so the packaged console is self-contained", () => {
    const root = createConsoleBuildFixture()
    try {
      const result = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })
      const stagedManifestsDirectory = join(
        result.stageDirectory,
        "apps",
        "console",
        "node_modules",
        "@pdpp",
        "polyfill-connectors",
        "manifests"
      )
      expect(
        readFileSync(join(stagedManifestsDirectory, "ynab.json"), "utf8")
      ).toBe("{}")
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("fails fast if the connector manifests package is not installed", () => {
    const root = createConsoleBuildFixture()
    try {
      rmSync(join(root, "node_modules", "@pdpp", "polyfill-connectors"), {
        force: true,
        recursive: true,
      })
      expect(() =>
        stageConsoleStack({ build: false, profile: "release", projectRoot: root })
      ).toThrow(/connector manifests package/)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("replaces stale output and records deterministic sha256 hashes", () => {
    const root = createConsoleBuildFixture()
    try {
      const first = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })
      writeFileSync(join(first.stageDirectory, "stale.txt"), "must be removed")
      const second = stageConsoleStack({
        build: false,
        profile: "release",
        projectRoot: root,
      })
      const manifest = JSON.parse(readFileSync(second.manifestPath, "utf8"))

      expect(manifest.profile).toBe("release")
      expect(manifest.server).toBe("apps/console/server.js")
      expect(manifest.hashes["apps/console/server.js"]).toMatch(
        /^sha256:[0-9a-f]{64}$/
      )
      expect(manifest.hashes["apps/console/server.js"]).toBe(
        `sha256:${createHash("sha256")
          .update(
            readFileSync(join(second.stageDirectory, "apps/console/server.js"))
          )
          .digest("hex")}`
      )
      expect(manifest.hashes["launch.mjs"]).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(manifest.hashes["manifest.json"]).toBeUndefined()
      expect(manifest.hashes["stale.txt"]).toBeUndefined()
      expect(manifest.runtimeEnv).toContain("PDPP_AS_URL")
      expect(manifest.runtimeEnv).toContain("PDPP_RS_URL")
      assert.deepEqual(
        Object.keys(manifest.hashes),
        [...Object.keys(manifest.hashes)].sort()
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
