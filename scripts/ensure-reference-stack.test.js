// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildManifest,
  launchScript,
  referenceStackRoot,
  verifyReferenceStackRoot,
} from "./ensure-reference-stack.js"
import { parseArgs as parseVerifyArgs } from "./verify-reference-stack.mjs"

const temporaryRoots = []

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "reference-stack-fixture-"))
  temporaryRoots.push(root)
  mkdirSync(join(root, "reference-implementation", "server"), {
    recursive: true,
  })
  mkdirSync(join(root, "node_modules", "tsx"), { recursive: true })
  mkdirSync(join(root, "node_modules", "patchright"), { recursive: true })
  mkdirSync(join(root, "node_modules", "better-sqlite3", "build", "Release"), {
    recursive: true,
  })
  mkdirSync(join(root, "node_modules", "sqlite-vec", "build", "Release"), {
    recursive: true,
  })
  writeFileSync(
    join(root, "reference-implementation", "server", "index.ts"),
    "export {}\n"
  )
  writeFileSync(join(root, "node_modules", "tsx", "package.json"), "{}\n")
  writeFileSync(
    join(root, "node_modules", "patchright", "package.json"),
    "{}\n"
  )
  writeFileSync(
    join(
      root,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node"
    ),
    "sqlite\n"
  )
  writeFileSync(
    join(root, "node_modules", "sqlite-vec", "build", "Release", "vec0.so"),
    "vec\n"
  )
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { force: true, recursive: true })
})

describe("reference stack staging contract", () => {
  it("derives one output root for every Tauri profile", () => {
    expect(referenceStackRoot("/workspace/data-connect", "release")).toBe(
      "/workspace/data-connect/src-tauri/target/reference-stack/ri"
    )
    expect(referenceStackRoot("/workspace/data-connect", "debug")).toBe(
      "/workspace/data-connect/src-tauri/target/reference-stack/ri"
    )
    expect(() =>
      referenceStackRoot("/workspace/data-connect", "../release")
    ).toThrow(/invalid Tauri profile/)
  })

  it("requires the verifier root to use the shared staging contract", () => {
    expect(
      parseVerifyArgs([
        "--profile",
        "release",
        "--root",
        "/workspace/src-tauri/target/reference-stack/ri",
      ])
    ).toMatchObject({
      profile: "release",
      root: "/workspace/src-tauri/target/reference-stack/ri",
    })
    expect(() =>
      parseVerifyArgs([
        "--profile",
        "release",
        "--root",
        "/workspace/src-tauri/target/release/reference-stack/ri",
      ])
    ).toThrow(/shared staging root/)
  })

  it("emits deterministic complete hashes and launcher inputs", () => {
    const first = fixtureRoot()
    const second = fixtureRoot()
    for (const root of [first, second]) {
      writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n')
      writeFileSync(join(root, "launch.mjs"), launchScript(), { mode: 0o755 })
    }
    const firstManifest = buildManifest({
      nodeBinary: process.execPath,
      projectRoot: first,
      stageRoot: first,
      target: "x86_64-unknown-linux-gnu",
      profile: "release",
    })
    const secondManifest = buildManifest({
      nodeBinary: process.execPath,
      projectRoot: second,
      stageRoot: second,
      target: "x86_64-unknown-linux-gnu",
      profile: "release",
    })
    expect(secondManifest).toEqual(firstManifest)
    expect(firstManifest.nativeModules["better-sqlite3"].abi).toBe(
      process.versions.modules
    )
    writeFileSync(
      join(first, "manifest.json"),
      `${JSON.stringify(firstManifest, null, 2)}\n`
    )
    expect(verifyReferenceStackRoot(first)).toEqual(firstManifest)
  })

  it("rejects a changed staged file", () => {
    const root = fixtureRoot()
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n')
    writeFileSync(join(root, "launch.mjs"), launchScript(), { mode: 0o755 })
    const manifest = buildManifest({
      nodeBinary: process.execPath,
      projectRoot: root,
      stageRoot: root,
      target: "linux-x64",
      profile: "debug",
    })
    writeFileSync(
      join(root, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
    writeFileSync(join(root, "launch.mjs"), `${launchScript()}\nchanged\n`)
    expect(() => verifyReferenceStackRoot(root)).toThrow(/manifest file hashes/)
  })

  it("keeps the launcher on the shipped Node ABI and disables first-boot downloads", () => {
    const source = launchScript()
    expect(source).toContain('process.execPath, ["--import", "tsx"')
    expect(source).toContain("PDPP_DB_PATH")
    expect(source).toContain(
      'PDPP_BIND_HOST: process.env.PDPP_BIND_HOST || "127.0.0.1"'
    )
    expect(source).toContain("AS_PORT")
    expect(source).toContain("RS_PORT")
    expect(source).toContain('PDPP_EMBEDDING_DOWNLOAD_ALLOWED || "0"')
    expect(source).toContain('PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1"')
  })
})
