// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildManifest,
  installStagedDependencies,
  launchScript,
  manifestTarget,
  pruneForeignPlatformPrebuilds,
  referenceGenerationId,
  referenceStackRoot,
  sourceInputHash,
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

function tauriHookFixture() {
  const root = fixtureRoot()
  const target = "x86_64-unknown-linux-gnu"
  const binaryDirectory = join(root, "src-tauri", "binaries")
  mkdirSync(binaryDirectory, { recursive: true })
  const nodeBinary = join(
    binaryDirectory,
    `pdpp-node-${target}`
  )
  writeFileSync(
    nodeBinary,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    { mode: 0o755 }
  )
  chmodSync(nodeBinary, 0o755)
  writeFileSync(
    join(binaryDirectory, "pdpp-node-aarch64-apple-darwin"),
    "not selected by the Tauri target triple\n"
  )

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { tsx: "4.0.0" } })
  )
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n')
  writeFileSync(
    join(root, "reference-implementation", "package.json"),
    JSON.stringify({ dependencies: {} })
  )
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true })
  writeFileSync(join(root, "node_modules", ".bin", "tsx"), "")

  for (const [name, path] of [
    ["@pdpp/collector-runtime", "packages/collector-runtime"],
    ["@pdpp/connector-protocol", "packages/connector-protocol"],
    ["@pdpp/display", "reference-implementation/vendor/display"],
    ["@pdpp/cli", "reference-implementation/vendor/cli"],
    ["@pdpp/read-core", "reference-implementation/vendor/read-core"],
    ["@pdpp/mcp-server", "reference-implementation/vendor/mcp-server"],
  ]) {
    const packageRoot = join(root, path)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name, version: "1.0.0" })
    )
  }
  for (const path of [
    "reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz",
    "reference-implementation/vendor/pdpp-reference-contract-0.1.0.tgz",
  ]) {
    writeFileSync(join(root, path), "fixture tarball")
  }

  const fakeNpm = join(root, "fake-npm.mjs")
  const nativeExtension =
    process.platform === "darwin"
      ? "dylib"
      : process.platform === "win32"
        ? "dll"
        : "so"
  writeFileSync(
    fakeNpm,
    `import { mkdirSync, writeFileSync } from "node:fs"\nimport { join } from "node:path"\n\nif (process.argv[2] === "install") {\n  const files = [\n    ["node_modules/tsx/package.json", "{}\\n"],\n    ["node_modules/patchright/package.json", "{}\\n"],\n    ["node_modules/better-sqlite3/build/Release/better_sqlite3.node", "sqlite\\n"],\n    ["node_modules/sqlite-vec/build/Release/vec0.${nativeExtension}", "vec\\n"],\n  ]\n  for (const [path, content] of files) {\n    const filePath = join(process.cwd(), path)\n    mkdirSync(join(filePath, ".."), { recursive: true })\n    writeFileSync(filePath, content)\n  }\n}\n`
  )

  return { fakeNpm, nodeBinary, root, target }
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

  it("uses Tauri's target triple in build hooks", () => {
    expect(
      manifestTarget(undefined, {
        TAURI_ENV_PLATFORM: "linux",
        TAURI_ENV_ARCH: "x86_64",
        TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu",
      })
    ).toBe("x86_64-unknown-linux-gnu")
    expect(
      manifestTarget("explicit-target", {
        TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu",
      })
    ).toBe("explicit-target")
  })

  it("keys immutable reference generations by the complete manifest", () => {
    const manifest = {
      profile: "release",
      target: "x86_64-unknown-linux-gnu",
      node: { abi: "127", version: "24.21.0" },
      inputs: { sha256: "same-source" },
      files: [{ path: "native.node", sha256: "linux-bytes" }],
    }
    expect(referenceGenerationId(manifest)).toBe(
      referenceGenerationId({ ...manifest })
    )
    expect(
      referenceGenerationId({ ...manifest, target: "aarch64-apple-darwin" })
    ).not.toBe(referenceGenerationId(manifest))
    expect(
      referenceGenerationId({
        ...manifest,
        files: [{ path: "native.node", sha256: "different-bytes" }],
      })
    ).not.toBe(referenceGenerationId(manifest))
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

  it.skipIf(process.platform !== "linux")(
    "reuses the explicit release stage from Tauri's target-triple hook",
    () => {
      const { fakeNpm, nodeBinary, root, target } = tauriHookFixture()
      const environmentKeys = [
        "PDPP_NODE_BINARY",
        "TARGET",
        "TAURI_ENV_TARGET",
        "TAURI_ENV_TARGET_TRIPLE",
        "npm_execpath",
      ]
      const previousEnvironment = Object.fromEntries(
        environmentKeys.map(key => [key, process.env[key]])
      )
      try {
        for (const key of environmentKeys) delete process.env[key]
        process.env.npm_execpath = fakeNpm
        const explicitStage = stageReferenceStack({
          projectRoot: root,
          nodeBinary,
          profile: "release",
          target,
        })
        process.env.TAURI_ENV_TARGET_TRIPLE = target
        const hookStage = stageReferenceStack({
          projectRoot: root,
          profile: "release",
        })

        expect(explicitStage.reused).toBe(false)
        expect(hookStage).toEqual({
          manifest: explicitStage.manifest,
          reused: true,
          root: explicitStage.root,
        })
      } finally {
        for (const key of environmentKeys) {
          const value = previousEnvironment[key]
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }
  )

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

  it("excludes workspace build output (dist/) from the source-input hash", () => {
    // Regression for #249: beforeBuildCommand reruns ensure-reference-stack.js
    // after the release workflow's own explicit staging step already ran it.
    // Both runs call buildWorkspacePackages, which rebuilds dist/ (including
    // dist/.tsbuildinfo) for packages/collector-runtime, packages/connector-protocol,
    // reference-implementation/vendor/read-core, and reference-implementation/vendor/mcp-server.
    // Those dist/ files are not behavioral source inputs. The build hook
    // must also use the same target triple as the explicit staging step;
    // Tauri provides it as TAURI_ENV_TARGET_TRIPLE.
    const projectRoot = process.cwd()
    const distDir = join(projectRoot, "packages", "collector-runtime", "dist")
    const tsbuildinfoPath = join(distDir, ".tsbuildinfo")
    const preexisting = existsSync(distDir)
    if (!preexisting) mkdirSync(distDir, { recursive: true })
    const originalContent = existsSync(tsbuildinfoPath)
      ? readFileSync(tsbuildinfoPath, "utf8")
      : undefined
    try {
      writeFileSync(tsbuildinfoPath, "buildinfo-run-A\n")
      const hashA = sourceInputHash(projectRoot)
      writeFileSync(tsbuildinfoPath, "buildinfo-run-B\n")
      const hashB = sourceInputHash(projectRoot)
      expect(hashB).toBe(hashA)
    } finally {
      if (!preexisting) rmSync(distDir, { force: true, recursive: true })
      else if (originalContent === undefined) rmSync(tsbuildinfoPath, { force: true })
      else writeFileSync(tsbuildinfoPath, originalContent)
    }
  })

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

  it("pins the staged install to the project's resolved lockfile instead of re-resolving ranges", () => {
    // Regression for F4: staging used to run `npm install --no-package-lock`
    // against a synthetic package.json, so a transitive dependency could
    // resolve to a newer version at build time without the cached stage's
    // source-input hash (which never reads package-lock.json contents for
    // resolution purposes here) reflecting that drift. The fix must (a)
    // carry the project's exact resolved lock into the stage, and (b) stop
    // telling npm to ignore it.
    const project = mkdtempSync(join(tmpdir(), "reference-stack-project-"))
    temporaryRoots.push(project)
    mkdirSync(join(project, "reference-implementation"), { recursive: true })
    writeFileSync(
      join(project, "reference-implementation", "package.json"),
      JSON.stringify({ dependencies: { tsx: "^4.23.13" } })
    )
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ devDependencies: { tsx: "^4.23.13" } })
    )
    const resolvedLock = JSON.stringify({
      name: "pdpp-reference-implementation",
      lockfileVersion: 3,
      packages: {
        "node_modules/tsx": { version: "4.23.13", resolved: "https://registry.npmjs.org/tsx/-/tsx-4.23.13.tgz" },
      },
    })
    writeFileSync(join(project, "package-lock.json"), resolvedLock)

    const stage = mkdtempSync(join(tmpdir(), "reference-stack-stage-"))
    temporaryRoots.push(stage)

    const npmRecorderDir = mkdtempSync(join(tmpdir(), "reference-stack-npm-"))
    temporaryRoots.push(npmRecorderDir)
    const invocationsPath = join(npmRecorderDir, "invocations.json")
    writeFileSync(invocationsPath, "[]")
    const npmRecorderPath = join(npmRecorderDir, "npm-recorder.cjs")
    writeFileSync(
      npmRecorderPath,
      `const fs = require("node:fs")
const invocations = JSON.parse(fs.readFileSync(${JSON.stringify(invocationsPath)}, "utf8"))
invocations.push(process.argv.slice(2))
fs.writeFileSync(${JSON.stringify(invocationsPath)}, JSON.stringify(invocations))
`
    )

    const previousNpmExecpath = process.env.npm_execpath
    process.env.npm_execpath = npmRecorderPath
    try {
      installStagedDependencies(project, stage, process.execPath)
    } finally {
      if (previousNpmExecpath === undefined) delete process.env.npm_execpath
      else process.env.npm_execpath = previousNpmExecpath
    }

    expect(readFileSync(join(stage, "package-lock.json"), "utf8")).toBe(
      resolvedLock
    )

    const invocations = JSON.parse(readFileSync(invocationsPath, "utf8"))
    const installArgs = invocations.find(args => args[0] === "install")
    expect(installArgs).toBeDefined()
    expect(installArgs).not.toContain("--no-package-lock")
  })
})
