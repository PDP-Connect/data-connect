import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  npmInstallCommand,
  runEnsurePdppRuntime,
} from "./ensure-pdpp-runtime.js"

function createRuntimeFixture() {
  const root = mkdtempSync(join(tmpdir(), "pdpp-runtime-install-"))
  writeFileSync(join(root, "package.json"), "{}")
  writeFileSync(join(root, "package-lock.json"), "{}")
  return root
}

describe("ensure PDPP runtime dependencies", () => {
  it("runs npm through Node on Windows when npm_execpath is available", () => {
    expect(
      npmInstallCommand({
        platformName: "win32",
        nodePath: "C:\\hostedtoolcache\\node.exe",
        npmCliPath: "C:\\hostedtoolcache\\npm\\bin\\npm-cli.js",
      })
    ).toEqual({
      command: "C:\\hostedtoolcache\\node.exe",
      args: [
        "C:\\hostedtoolcache\\npm\\bin\\npm-cli.js",
        "ci",
        "--ignore-scripts",
      ],
      shell: false,
    })
  })

  it("falls back to npm.cmd on Windows without shell injection inputs", () => {
    expect(
      npmInstallCommand({
        platformName: "win32",
        nodePath: "C:\\hostedtoolcache\\node.exe",
        npmCliPath: undefined,
      })
    ).toEqual({
      command: "npm.cmd",
      args: ["ci", "--ignore-scripts"],
      shell: true,
    })
  })

  it("reports spawn errors and non-zero exits with useful messages", () => {
    const root = createRuntimeFixture()
    try {
      expect(() =>
        runEnsurePdppRuntime({
          root,
          spawn: () => ({ error: new Error("spawn npm ENOENT") }),
        })
      ).toThrow("spawn npm ENOENT")

      expect(() =>
        runEnsurePdppRuntime({
          root,
          spawn: () => ({ status: 1 }),
        })
      ).toThrow("npm exited with status 1")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("writes the install stamp after npm restores runtime packages", () => {
    const root = createRuntimeFixture()
    try {
      let invocation
      const status = runEnsurePdppRuntime({
        root,
        spawn: (...args) => {
          invocation = args
          for (const dependency of ["p-queue", "patchright"]) {
            const packageRoot = join(root, "node_modules", dependency)
            mkdirSync(packageRoot, { recursive: true })
            writeFileSync(join(packageRoot, "package.json"), "{}")
          }
          return { status: 0 }
        },
        platformName: "linux",
        npmCliPath: undefined,
      })

      expect(status).toBe(0)
      expect(invocation).toEqual([
        "npm",
        ["ci", "--ignore-scripts"],
        { cwd: root, stdio: "inherit", shell: false },
      ])
      expect(readFileSync(join(root, ".install-stamp"), "utf8")).toMatch(/\S/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
