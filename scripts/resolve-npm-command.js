// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs"
import { basename } from "node:path"

function executableName(path) {
  return path ? basename(path.replaceAll("\\", "/")).toLowerCase() : ""
}

function packageManagerFromEnvironment(userAgent, npmExecPath) {
  const userAgentManager = userAgent?.match(
    /(?:^|\s)(npm|pnpm|yarn)\/[^\s]+/
  )?.[1]
  if (userAgentManager) return userAgentManager

  const executable = executableName(npmExecPath)
  if (executable.startsWith("pnpm")) return "pnpm"
  if (executable.startsWith("yarn")) return "yarn"
  return "npm"
}

function isNpmCliPath(path) {
  return /^npm(?:-cli)?(?:\.(?:c?js|cmd))?$/.test(executableName(path))
}

export function resolveNpmCommand({
  nodePath = process.execPath,
  npmExecPath = process.env.npm_execpath,
  platformName = process.platform,
  userAgent = process.env.npm_config_user_agent,
} = {}) {
  const packageManager = packageManagerFromEnvironment(userAgent, npmExecPath)
  if (packageManager === "npm" && npmExecPath && isNpmCliPath(npmExecPath)) {
    if (existsSync(npmExecPath)) {
      return { command: nodePath, prefixArgs: [npmExecPath], shell: false }
    }
  }

  return {
    command: platformName === "win32" ? "npm.cmd" : "npm",
    prefixArgs: [],
    shell: platformName === "win32",
  }
}
