// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isMainModule } from "./is-main-module.js"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runtimeRoot = join(root, "pdpp-runtime")

function runtimeStamp(root) {
  return createHash("sha256")
    .update(readFileSync(join(root, "package.json")))
    .update(readFileSync(join(root, "package-lock.json")))
    .digest("hex")
}

export function npmInstallCommand(options = {}) {
  const {
    platformName = process.platform,
    nodePath = process.execPath,
  } = options
  const npmCliPath = Object.hasOwn(options, "npmCliPath")
    ? options.npmCliPath
    : process.env.npm_execpath
  return {
    command: npmCliPath
      ? nodePath
      : platformName === "win32"
        ? "npm.cmd"
        : "npm",
    args: [...(npmCliPath ? [npmCliPath] : []), "ci", "--ignore-scripts"],
    shell: !npmCliPath && platformName === "win32",
  }
}

export function runEnsurePdppRuntime(options = {}) {
  const {
    root = runtimeRoot,
    spawn = spawnSync,
    platformName = process.platform,
    nodePath = process.execPath,
  } = options
  const npmCliPath = Object.hasOwn(options, "npmCliPath")
    ? options.npmCliPath
    : process.env.npm_execpath
  const required = ["p-queue", "patchright"].map(name =>
    join(root, "node_modules", name, "package.json")
  )
  const stampPath = join(root, ".install-stamp")
  const stamp = runtimeStamp(root)

  if (
    required.every(existsSync) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === stamp
  ) {
    return 0
  }

  const installCommand = npmInstallCommand({
    platformName,
    nodePath,
    npmCliPath,
  })
  const install = spawn(installCommand.command, installCommand.args, {
    cwd: root,
    stdio: "inherit",
    shell: installCommand.shell,
  })
  if (install.error) {
    throw new Error(
      `Failed to install PDPP runtime dependencies: ${install.error.message}`
    )
  }
  if (install.status !== 0) {
    throw new Error(
      `Failed to install PDPP runtime dependencies: npm exited with status ${install.status ?? "unknown"}`
    )
  }
  writeFileSync(stampPath, `${stamp}\n`)
  return 0
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exit(runEnsurePdppRuntime())
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
