// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function isMainModule(
  moduleUrl,
  argvPath,
  platform = process.platform,
  realpath = realpathSync.native
) {
  if (!argvPath) return false
  const windows = platform === "win32"
  try {
    const modulePath = fileURLToPath(moduleUrl, { windows })
    return canonicalPath(modulePath, windows, realpath) ===
      canonicalPath(argvPath, windows, realpath)
  } catch {
    return false
  }
}

function canonicalPath(value, windows, realpath) {
  let resolved = value
  try {
    resolved = realpath(value)
  } catch {
    // A not-yet-existing path can still be compared after lexical normalization.
  }
  if (!windows) return path.resolve(resolved)

  const withoutExtendedPrefix = resolved.replace(/^\\\\\?\\/, "")
  return path.win32.normalize(withoutExtendedPrefix).toLowerCase()
}
