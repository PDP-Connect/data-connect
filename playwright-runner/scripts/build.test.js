// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  copyBrowserDirectory,
  findChromiumDir,
  getBrowserDirectoryName,
  getPlaywrightBrowserPath,
  parseBuildOptions,
  reportBuildCompletion,
  supportsBrowserProvisioning,
} from "./build.js"

describe("playwright-runner build options", () => {
  it("resolves the hermetic browser selector relative to Playwright's own core dependency", () => {
    const coreRoot = join("fixture", "nested", "node_modules", "playwright-core")
    expect(getPlaywrightBrowserPath({
      env: { PLAYWRIGHT_BROWSERS_PATH: "0" },
      resolveCoreManifest: () => join(coreRoot, "package.json"),
    })).toBe(join(coreRoot, ".local-browsers"))
    expect(getPlaywrightBrowserPath({
      env: { PLAYWRIGHT_BROWSERS_PATH: "fixture-custom-cache" },
      resolveCoreManifest: () => { throw new Error("unexpected package lookup") },
    })).toBe("fixture-custom-cache")
  })

  it("reports a missing hermetic browser package rather than using a global cache", () => {
    const missingCore = Object.assign(new Error("playwright-core manifest not found"), {
      code: "MODULE_NOT_FOUND",
    })
    expect(() => getPlaywrightBrowserPath({
      env: { PLAYWRIGHT_BROWSERS_PATH: "0" },
      resolveCoreManifest: () => { throw missingCore },
    })).toThrow(missingCore)
  })

  it("uses the configured browser cache without resolving the hermetic package", () => {
    const cache = join(tmpdir(), "release cache")
    let calls = 0
    expect(getPlaywrightBrowserPath({
      env: { PLAYWRIGHT_BROWSERS_PATH: cache },
      resolveCoreManifest: () => {
        calls++
        throw new Error("the explicit cache must not look up playwright-core")
      },
    })).toBe(cache)
    expect(calls).toBe(0)
  })

  it("keeps an absolute matrix output path when producing a lean binary", () => {
    const outputPath = resolve(tmpdir(), "matrix output", "runner")
    expect(parseBuildOptions(["--lean", "--output", outputPath, "--target", "node22-linux-x64"]))
      .toEqual({ isLean: true, outputPath, requireBrowser: false, target: "node22-linux-x64" })
  })

  it("does not download a browser during npm install", () => {
    const packageDocument = JSON.parse(
      readFileSync(resolve("playwright-runner/package.json"), "utf8")
    )

    expect(packageDocument.scripts.postinstall).toBeUndefined()
  })

  it("does not provision Chromium during an ordinary local build", () => {
    const options = parseBuildOptions([])

    expect(options.requireBrowser).toBe(false)
    expect(options.isLean).toBe(false)
  })

  it("requires Chromium for release builds and honors matrix output", () => {
    const options = parseBuildOptions([
      "--require-browser",
      "--target",
      "node22-linux-x64",
      "--output",
      "dist/release-runner",
    ])

    expect(options.requireBrowser).toBe(true)
    expect(options.target).toBe("node22-linux-x64")
    expect(options.outputPath).toMatch(
      /playwright-runner\/dist\/release-runner$/
    )

    const failure = new Error("synthetic required finalization failure")
    const rejectFinalization = () => {
      throw failure
    }
    const reported = []
    expect(() =>
      reportBuildCompletion("darwin", rejectFinalization, message =>
        reported.push(message)
      )
    ).toThrow(failure)
    expect(reported).toEqual(["Signing binary for macOS..."])

    const completed = []
    reportBuildCompletion(
      "darwin",
      () => completed.push("sign callback"),
      message => completed.push(message)
    )
    expect(completed).toEqual([
      "Signing binary for macOS...",
      "sign callback",
      "Binary signed successfully",
      "Build complete!",
    ])

    const otherPlatform = []
    reportBuildCompletion("linux", rejectFinalization, message =>
      otherPlatform.push(message)
    )
    expect(otherPlatform).toEqual(["Build complete!"])
  })

  it("rejects a missing target value before starting a build", () => {
    expect(() => parseBuildOptions(["--target"])).toThrow("--target requires a value")
  })

  it("does not treat the next flag as an output path", () => {
    expect(() => parseBuildOptions(["--output", "--lean"])).toThrow("--output requires a value")
  })

  it("keeps lean builds incompatible with browser provisioning", () => {
    expect(() => parseBuildOptions(["--lean", "--require-browser"])).toThrow(
      "cannot be used together"
    )
  })

  it("guards browser provisioning by Playwright-supported Linux hosts", () => {
    expect(
      supportsBrowserProvisioning("linux", 'ID=ubuntu\nVERSION_ID="22.04"\n')
    ).toBe(true)
    expect(
      supportsBrowserProvisioning("linux", 'ID=ubuntu\nVERSION_ID="26.04"\n')
    ).toBe(false)
    expect(supportsBrowserProvisioning("darwin")).toBe(true)
    expect(supportsBrowserProvisioning("win32")).toBe(true)
  })

  it("uses only the Chromium cache directory name on Windows", () => {
    expect(
      getBrowserDirectoryName(
        "C:\\Users\\runneradmin\\AppData\\Local\\ms-playwright\\chromium-1200",
        "win32"
      )
    ).toBe("chromium-1200")
  })

  it("preserves system-first browser selection and supports current macOS layouts", () => {
    const runnerSource = readFileSync(
      resolve("playwright-runner/index.cjs"),
      "utf8"
    )
    const resolverSource = runnerSource.slice(
      runnerSource.indexOf("function resolveBrowserPath()"),
      runnerSource.indexOf("// Launch a persistent browser context")
    )

    expect(runnerSource).toContain("chrome-mac-arm64")
    expect(runnerSource).toContain("chrome-mac-x64")
    expect(resolverSource.indexOf("getSystemChromePath()")).toBeLessThan(
      resolverSource.indexOf("getDownloadedChromiumPath()")
    )
  })
})

describe("Chromium cache selection", () => {
  it("skips incomplete and headless-only caches in favor of a usable browser", () => {
    const root = mkdtempSync(join(tmpdir(), "browser-cache-selection-"))
    try {
      mkdirSync(join(root, "chromium-1000"))
      mkdirSync(join(root, "chromium-headless-shell-1100"))
      const usable = join(root, "chromium-1200")
      const bin = join(usable, "chrome-linux64")
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, "chrome"), "synthetic browser")
      expect(findChromiumDir(root, "linux")).toBe(usable)
      rmSync(usable, { recursive: true })
      expect(findChromiumDir(root, "linux")).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("copyBrowserDirectory", () => {
  it("rejects a file in place of the destination directory without overwriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "browser-copy-conflict-"))
    try {
      const source = join(root, "source")
      const destination = join(root, "browser-output")
      mkdirSync(source)
      writeFileSync(join(source, "browser"), "fixture binary")
      writeFileSync(destination, "existing output")

      expect(() => copyBrowserDirectory(source, destination)).toThrow()
      expect(readFileSync(destination, "utf8")).toBe("existing output")
      expect(readFileSync(join(source, "browser"), "utf8")).toBe("fixture binary")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps the macOS framework symlinks relative", () => {
    const root = mkdtempSync(join(tmpdir(), "browser-copy-"))
    try {
      const framework = join(root, "source", "F.framework")
      mkdirSync(join(framework, "Versions", "1.0", "Helpers"), {
        recursive: true,
      })
      writeFileSync(join(framework, "Versions", "1.0", "F"), "binary")
      symlinkSync("1.0", join(framework, "Versions", "Current"))
      symlinkSync("Versions/Current/F", join(framework, "F"))
      symlinkSync("Versions/Current/Helpers", join(framework, "Helpers"))

      copyBrowserDirectory(join(root, "source"), join(root, "copy"))

      const copied = join(root, "copy", "F.framework")
      expect(readlinkSync(join(copied, "Versions", "Current"))).toBe("1.0")
      expect(readlinkSync(join(copied, "F"))).toBe("Versions/Current/F")
      expect(readlinkSync(join(copied, "Helpers"))).toBe(
        "Versions/Current/Helpers"
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})


it("refuses browser provisioning without an exact supported Linux release", () => {
  expect(supportsBrowserProvisioning("linux", 'VERSION_ID="12"\n')).toBe(false)
  expect(supportsBrowserProvisioning("linux", 'ID=debian\nVERSION_ID="12.1"\n')).toBe(false)
  expect(supportsBrowserProvisioning("linux", 'ID=debian\nVERSION_ID="12"\n')).toBe(true)
})

it("does not leave a browser destination behind after a missing-cache copy", () => {
  const root = mkdtempSync(join(tmpdir(), "browser-copy-missing-"))
  try {
    const output = join(root, "output")
    expect(() => copyBrowserDirectory(join(root, "missing"), output))
      .toThrow(expect.objectContaining({ code: "ENOENT" }))
    expect(() => readFileSync(output)).toThrow(expect.objectContaining({ code: "ENOENT" }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("keeps an absolute output path independent of the working directory", () => {
  const output = join(resolve(tmpdir()), "fixture-runner", "result")
  expect(parseBuildOptions(["--output", output, "--lean"])).toMatchObject({
    outputPath: output,
    isLean: true,
    requireBrowser: false,
  })
})

it("keeps a non-hermetic browser cache path as configured, including spaces", () => {
  const cache = join(resolve(tmpdir()), "fixture browser cache")
  expect(getPlaywrightBrowserPath({
    env: { PLAYWRIGHT_BROWSERS_PATH: cache },
    resolveCoreManifest: () => { throw new Error("non-hermetic cache must not resolve a package") },
  })).toBe(cache)
})
