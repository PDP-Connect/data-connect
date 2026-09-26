// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
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

  it("matches Windows separators, drive letter casing, and file URLs", () => {
    expect(
      isMainModule(
        "file:///D:/a/data-connect/reference-implementation/server/index.ts",
        "d:\\a\\data-connect\\reference-implementation\\server\\index.ts",
        "win32"
      )
    ).toBe(true)
  })

  it("matches a Windows 8.3 path after realpath resolution", () => {
    const realpath = value => value.replace("RUNNER~1", "runneradmin")
    expect(
      isMainModule(
        "file:///C:/Users/runneradmin/work/server/index.ts",
        "C:\\Users\\RUNNER~1\\work\\server\\index.ts",
        "win32",
        realpath
      )
    ).toBe(true)
  })

  it("matches a Windows symlink path after realpath resolution", () => {
    const target = "C:\\Users\\runneradmin\\work\\server\\index.ts"
    const symlink = "C:\\Users\\runneradmin\\work\\link\\index.ts"
    const realpath = value => (value === symlink ? target : value)
    expect(
      isMainModule(
        "file:///C:/Users/runneradmin/work/server/index.ts",
        symlink,
        "win32",
        realpath
      )
    ).toBe(true)
  })

  it("matches Windows UNC file URLs", () => {
    expect(
      isMainModule(
        "file://build-share/releases/app/server/index.ts",
        "\\\\build-share\\releases\\app\\server\\index.ts",
        "win32",
        value => value
      )
    ).toBe(true)
  })

  it("matches Windows extended-length paths", () => {
    expect(
      isMainModule(
        "file:///C:/Program%20Files/DataConnect/server/index.ts",
        "\\\\?\\C:\\Program Files\\DataConnect\\server\\index.ts",
        "win32",
        value => value
      )
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
