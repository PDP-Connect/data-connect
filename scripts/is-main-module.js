import { pathToFileURL } from "node:url"

export function isMainModule(moduleUrl, argvPath, platform = process.platform) {
  if (!argvPath) return false
  return (
    moduleUrl ===
    pathToFileURL(argvPath, { windows: platform === "win32" }).href
  )
}
