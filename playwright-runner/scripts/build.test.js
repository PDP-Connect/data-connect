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
  getBrowserDirectoryName,
  parseBuildOptions,
  supportsBrowserProvisioning,
} from "./build.js"

describe("playwright-runner build options", () => {
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

describe("copyBrowserDirectory", () => {
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
