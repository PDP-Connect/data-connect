import { describe, expect, it } from "vitest"
import { isMainModule } from "./is-main-module.js"

describe("isMainModule", () => {
  it("matches a POSIX entrypoint", () => {
    expect(
      isMainModule(
        "file:///home/runner/work/data-connect/scripts/resolve-connectors.js",
        "/home/runner/work/data-connect/scripts/resolve-connectors.js",
        "linux"
      )
    ).toBe(true)
  })

  it("matches a Windows entrypoint with backslash separators", () => {
    const moduleUrl =
      "file:///D:/a/data-connect/scripts/resolve-connectors.js"
    const argvPath = "D:\\a\\data-connect\\scripts\\resolve-connectors.js"
    expect(moduleUrl).not.toBe(`file://${argvPath}`)
    expect(
      isMainModule(moduleUrl, argvPath, "win32")
    ).toBe(true)
  })

  it("rejects an imported module and a missing argv path", () => {
    expect(
      isMainModule(
        "file:///D:/a/data-connect/scripts/verify-release-ref.mjs",
        "D:\\a\\data-connect\\scripts\\resolve-connectors.js",
        "win32"
      )
    ).toBe(false)
    expect(isMainModule("file:///tmp/script.js", undefined)).toBe(false)
  })
})
