// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  mkdtempSync,
  mkdirSync,
  linkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  parseArgs,
  nativeTauriTarget,
  sidecarFilename,
  stagePdppNode,
  RELEASE_NODE_VERSION,
} from "./stage-pdpp-node.mjs"

describe("stage PDPP Node.js sidecar", () => {
  it.each([
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
  ])("maps native %s/%s to %s", (platform, arch, target) => {
    expect(nativeTauriTarget(platform, arch)).toEqual({
      target,
      expectedPlatform: platform,
      expectedArch: arch,
    })
  })

  it.each([
    ["aarch64-apple-darwin", "pdpp-node-aarch64-apple-darwin"],
    ["x86_64-apple-darwin", "pdpp-node-x86_64-apple-darwin"],
    ["x86_64-unknown-linux-gnu", "pdpp-node-x86_64-unknown-linux-gnu"],
    ["x86_64-pc-windows-msvc", "pdpp-node-x86_64-pc-windows-msvc.exe"],
  ])(
    "uses Tauri's target-qualified sidecar name for %s",
    (target, filename) => {
      expect(sidecarFilename(target)).toBe(filename)
    }
  )

  it("copies the setup-node executable only when version and architecture match", () => {
    const root = mkdtempSync(join(tmpdir(), "pdpp-node-sidecar-"))
    const source = join(root, "node-source")
    const sourceLicense = join(root, "LICENSE")
    try {
      mkdirSync(join(root, "src-tauri"), { recursive: true })
      writeFileSync(source, "fixture", { mode: 0o755 })
      writeFileSync(sourceLicense, "Node.js license fixture")
      const staged = stagePdppNode({
        target: "x86_64-unknown-linux-gnu",
        expectedPlatform: "linux",
        expectedArch: "x64",
        source,
        sourceLicense,
        actualPlatform: "linux",
        actualArch: "x64",
        nodeVersion: RELEASE_NODE_VERSION,
        projectRoot: root,
      })
      expect(staged).toEqual({
        executable: join(
          root,
          "src-tauri/binaries/pdpp-node-x86_64-unknown-linux-gnu"
        ),
        license: join(root, "src-tauri/binaries/pdpp-node-LICENSE"),
      })
      expect(readFileSync(staged.executable, "utf8")).toBe("fixture")
      expect(readFileSync(staged.license, "utf8")).toBe(
        "Node.js license fixture"
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects the wrong Node major or native architecture", () => {
    const common = {
      target: "x86_64-unknown-linux-gnu",
      expectedPlatform: "linux",
      expectedArch: "x64",
      source: process.execPath,
      sourceLicense: process.execPath,
      actualPlatform: "linux",
      actualArch: "x64",
      projectRoot: tmpdir(),
    }
    expect(() => stagePdppNode({ ...common, nodeVersion: "22.18.0" })).toThrow(
      `must use Node.js ${RELEASE_NODE_VERSION}`
    )
    expect(() =>
      stagePdppNode({
        ...common,
        nodeVersion: RELEASE_NODE_VERSION,
        actualArch: "arm64",
      })
    ).toThrow("architecture mismatch")
  })

  it("replaces debug hard links without modifying their source files", () => {
    const root = mkdtempSync(join(tmpdir(), "pdpp-node-hard-link-"))
    const source = join(root, "release-node")
    const sourceLicense = join(root, "release-LICENSE")
    const developmentNode = join(root, "development-node")
    const developmentLicense = join(root, "development-LICENSE")
    const binaries = join(root, "src-tauri", "binaries")
    try {
      mkdirSync(binaries, { recursive: true })
      writeFileSync(source, "release", { mode: 0o755 })
      writeFileSync(sourceLicense, "release license")
      writeFileSync(developmentNode, "development", { mode: 0o755 })
      writeFileSync(developmentLicense, "development license")
      linkSync(
        developmentNode,
        join(binaries, "pdpp-node-x86_64-unknown-linux-gnu")
      )
      linkSync(developmentLicense, join(binaries, "pdpp-node-LICENSE"))

      stagePdppNode({
        target: "x86_64-unknown-linux-gnu",
        expectedPlatform: "linux",
        expectedArch: "x64",
        source,
        sourceLicense,
        actualPlatform: "linux",
        actualArch: "x64",
        nodeVersion: RELEASE_NODE_VERSION,
        projectRoot: root,
      })

      expect(readFileSync(developmentNode, "utf8")).toBe("development")
      expect(readFileSync(developmentLicense, "utf8")).toBe(
        "development license"
      )
      expect(
        readFileSync(
          join(binaries, "pdpp-node-x86_64-unknown-linux-gnu"),
          "utf8"
        )
      ).toBe("release")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("parses the release workflow arguments", () => {
    expect(
      parseArgs([
        "--target",
        "aarch64-apple-darwin",
        "--expected-platform",
        "darwin",
        "--expected-arch",
        "arm64",
      ])
    ).toEqual({
      target: "aarch64-apple-darwin",
      expectedPlatform: "darwin",
      expectedArch: "arm64",
    })
  })

  it("gates the supported local production build on the same staging contract", () => {
    const buildScript = readFileSync(
      resolve(process.cwd(), "scripts/build-prod.js"),
      "utf8"
    )
    expect(buildScript).toContain(
      "stagePdppNode({ ...nativeTauriTarget(PLAT, arch()), projectRoot: ROOT })"
    )
  })
})
