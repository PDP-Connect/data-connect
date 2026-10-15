// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  MACOS_NODE_HELPER,
  packageMacosNodeHelper,
} from "./package-macos-node-helper.mjs"

describe("macOS Node helper packaging", () => {
  it("moves Node into a background bundle while preserving its executable mode", () => {
    const root = mkdtempSync(join(tmpdir(), "dc-helper-"))
    try {
      mkdirSync(join(root, "Contents/MacOS"), { recursive: true })
      writeFileSync(
        join(root, "Contents/Info.plist"),
        "<key>CFBundleVersion</key><string>0.7.60</string>"
      )
      const original = join(root, "Contents/MacOS/pdpp-node")
      writeFileSync(original, "node fixture")
      chmodSync(original, 0o755)
      packageMacosNodeHelper(root)
      expect(existsSync(original)).toBe(false)
      expect(readFileSync(join(root, MACOS_NODE_HELPER), "utf8")).toBe(
        "node fixture"
      )
      expect(statSync(join(root, MACOS_NODE_HELPER)).mode & 0o777).toBe(0o755)
      const plist = readFileSync(
        join(
          root,
          "Contents/Helpers/DataConnect Helper.app/Contents/Info.plist"
        ),
        "utf8"
      )
      expect(plist).toContain("<key>LSBackgroundOnly</key><true/>")
      expect(plist).toContain(
        "<key>CFBundleIdentifier</key><string>dev.dataconnect.node</string>"
      )
      expect(plist).toContain(
        "<key>CFBundleExecutable</key><string>DataConnect</string>"
      )
      expect(plist).toContain(
        "<key>CFBundleVersion</key><string>0.7.60</string>"
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
