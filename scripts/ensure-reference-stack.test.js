// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildManifest,
  launchScript,
  pruneForeignPlatformPrebuilds,
  referenceStackRoot,
  stageReferenceStack,
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
  mkdirSync(join(root, "scripts"), { recursive: true })
  writeFileSync(join(root, "scripts", "ensure-reference-stack.js"), "// recipe v1\n")
  writeFileSync(join(root, "scripts", "stage-generations.js"), "// helper v1\n")
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { force: true, recursive: true })
})

describe("reference stack staging contract", () => {
  it("derives a profile-scoped output root", () => {
    expect(referenceStackRoot("/workspace/data-connect", "release")).toBe(
      "/workspace/data-connect/src-tauri/target/release/reference-stack/ri"
    )
    expect(referenceStackRoot("/workspace/data-connect", "debug")).toBe(
      "/workspace/data-connect/src-tauri/target/debug/reference-stack/ri"
    )
    expect(() =>
      referenceStackRoot("/workspace/data-connect", "../release")
    ).toThrow(/invalid Tauri profile/)
  })

  it("requires the verifier root to use the same profile-scoped contract", () => {
    expect(
      parseVerifyArgs([
        "--profile",
        "release",
        "--root",
        "/workspace/src-tauri/target/release/reference-stack/ri",
      ])
    ).toMatchObject({
      profile: "release",
      root: "/workspace/src-tauri/target/release/reference-stack/ri",
    })
    expect(() =>
      parseVerifyArgs([
        "--profile",
        "release",
        "--root",
        "/workspace/src-tauri/target/reference-stack/ri",
      ])
    ).toThrow(/profile-scoped/)
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

  for (const packageName of ["better-sqlite3", "better-sqlite3-multiple-ciphers"]) {
    it(`prunes every foreign-platform ${packageName} prebuild`, () => {
      const root = fixtureRoot()
      const prebuildsDir = join(root, "node_modules", packageName, "prebuilds")
      mkdirSync(prebuildsDir, { recursive: true })
      for (const name of [
        "linux-x64.node",
        "linux-arm64.node",
        "linuxmusl-x64.node",
        "linuxmusl-arm64.node",
        "darwin-x64.node",
        "darwin-arm64.node",
        "win32-x64.node",
        "win32-arm64.node",
      ]) {
        writeFileSync(join(prebuildsDir, name), "")
      }

      pruneForeignPlatformPrebuilds(root)

      expect(readdirSync(prebuildsDir)).toEqual([
        `${process.platform}-${process.arch}.node`,
      ])
    })
  }

  it("does nothing when neither package ships a prebuilds directory", () => {
    const root = fixtureRoot()
    expect(() => pruneForeignPlatformPrebuilds(root)).not.toThrow()
    expect(
      existsSync(
        join(root, "node_modules", "better-sqlite3-multiple-ciphers")
      )
    ).toBe(false)
  })
  it("the staging module resolves its own helpers at import time", async () => {
    // Regression: an import of ./stage-generations.js was once inserted
    // into the middle of the file, INSIDE the launchScript() template
    // string. The module still parsed and every unit test still passed,
    // because nothing here calls the full stage path -- but the real build
    // died with "publishStageGeneration is not defined", and the generated
    // launch.mjs would have shipped a bogus import. Assert both halves.
    const module = await import("./ensure-reference-stack.js")
    const generations = await import("./stage-generations.js")
    expect(typeof generations.publishStageGeneration).toBe("function")
    expect(typeof generations.collectOldStageGenerations).toBe("function")
    expect(typeof generations.KEEP_GENERATIONS).toBe("number")
    expect(module.launchScript()).not.toContain("stage-generations")
  })

  it("reuses a valid staged root whose manifest matches the current build", () => {
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

    const result = stageReferenceStack({
      projectRoot: root,
      outputRoot: root,
      nodeBinary: process.execPath,
      target: "linux-x64",
      profile: "debug",
    })

    expect(result).toEqual({ manifest, reused: true, root })
  })

  it("fails closed, without deleting anything, on a stage that matches by metadata but is missing a required file", () => {
    // A corrupt/incomplete stage can still match on metadata (interrupted
    // publish, partial disk write, external deletion of one file). Cache
    // reuse must reject it instead of trusting metadata alone.
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
    // Prove the fixture is genuinely valid before corrupting it, so the
    // throw below is caused by the deletion, not a broken fixture.
    expect(verifyReferenceStackRoot(root)).toEqual(manifest)

    rmSync(join(root, "launch.mjs"))

    expect(() =>
      stageReferenceStack({
        projectRoot: root,
        outputRoot: root,
        nodeBinary: process.execPath,
        target: "linux-x64",
        profile: "debug",
      })
    ).toThrow(/failed integrity verification.*Stop the app.*move it aside/s)
    // Fail-closed must not touch the corrupt tree: no destructive recovery.
    expect(existsSync(root)).toBe(true)
    expect(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))).toEqual(manifest)
    expect(readFileSync(join(root, "node_modules", "tsx", "package.json"), "utf8")).toBe("{}\n")
  })

  for (const recipeFile of ["ensure-reference-stack.js", "stage-generations.js"]) {
    it(`invalidates the cache when ${recipeFile} changes`, () => {
      const root = fixtureRoot()
      writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n')
      const before = buildManifest({
        nodeBinary: process.execPath,
        projectRoot: root,
        stageRoot: root,
        target: "linux-x64",
        profile: "debug",
      })
      writeFileSync(join(root, "scripts", recipeFile), "// changed\n")
      const after = buildManifest({
        nodeBinary: process.execPath,
        projectRoot: root,
        stageRoot: root,
        target: "linux-x64",
        profile: "debug",
      })
      expect(after.inputs.sha256).not.toBe(before.inputs.sha256)
    })
  }

  it("prunes a symlinked node_modules before traversing into it (cycle-safe)", () => {
    // Only the source tree carries the cycle: staged dependencies must
    // still be traversed and hashed for integrity.
    const project = fixtureRoot()
    const cyclePath = join(project, "reference-implementation", "node_modules")
    symlinkSync(project, cyclePath, process.platform === "win32" ? "junction" : "dir")
    writeFileSync(join(project, "package-lock.json"), '{"lockfileVersion":3}\n')
    const stage = fixtureRoot()
    writeFileSync(join(stage, "package-lock.json"), '{"lockfileVersion":3}\n')
    writeFileSync(join(stage, "launch.mjs"), launchScript(), { mode: 0o755 })

    const manifest = buildManifest({
        nodeBinary: process.execPath,
        projectRoot: project,
        stageRoot: stage,
        target: "linux-x64",
        profile: "debug",
      })
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "node_modules/tsx/package.json" }),
    ]))
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest)}\n`)
    expect(verifyReferenceStackRoot(stage)).toEqual(manifest)
    writeFileSync(join(stage, "node_modules", "tsx", "package.json"), '{"changed":true}\n')
    expect(() => verifyReferenceStackRoot(stage)).toThrow(/manifest file hashes/)
  })
})
