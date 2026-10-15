#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { isMainModule } from "./is-main-module.js"

export const MACOS_NODE_HELPER =
  "Contents/Helpers/DataConnect Helper.app/Contents/MacOS/DataConnect"

// Run after Tauri bundling, before signing or creating the DMG. libuv checks
// into LaunchServices when a dependency sets process.title; it must see the
// helper's background-only identity rather than the outer foreground app.
export function packageMacosNodeHelper(appPath) {
  const contents = join(
    appPath,
    "Contents/Helpers/DataConnect Helper.app/Contents"
  )
  const version = readFileSync(
    join(appPath, "Contents/Info.plist"),
    "utf8"
  ).match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
  if (!version) throw new Error("Outer app is missing CFBundleVersion")
  mkdirSync(join(contents, "MacOS"), { recursive: true })
  renameSync(
    join(appPath, "Contents/MacOS/pdpp-node"),
    join(appPath, MACOS_NODE_HELPER)
  )
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>DataConnect</string>
  <key>CFBundleIdentifier</key><string>dev.dataconnect.node</string>
  <key>CFBundleName</key><string>DataConnect</string>
  <key>CFBundleDisplayName</key><string>DataConnect</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSBackgroundOnly</key><true/>
</dict></plist>
`
  )
}

if (isMainModule(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error("Usage: package-macos-node-helper.mjs <app>")
  packageMacosNodeHelper(resolve(process.argv[2]))
}
