#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { isMainModule } from "./is-main-module.js"

const ROOT = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = dirname(ROOT)
const DEFAULT_PROFILE = "release"
const STAGE_DIRECTORY = ["src-tauri", "target", "reference-stack", "console"]

// These are read by the generated Next server, the console's reference proxy,
// or the imported reference-topology/auth helpers. The launcher inherits the
// complete parent environment; this list documents the supported runtime
// contract in the staged manifest.
export const CONSOLE_RUNTIME_ENV = [
  "NODE_ENV",
  "PORT",
  "HOSTNAME",
  "KEEP_ALIVE_TIMEOUT",
  "PDPP_AS_URL",
  "PDPP_RS_URL",
  "PDPP_REFERENCE_READY_FILE",
  "PDPP_REFERENCE_ORIGIN",
  "PDPP_REFERENCE_MODE",
  "AS_PUBLIC_URL",
  "RS_PUBLIC_URL",
  "PDPP_OWNER_PASSWORD",
  "PDPP_OWNER_SUBJECT_ID",
  "PDPP_ENABLE_DASHBOARD",
  "PDPP_EXPLORE_TIMELINE_DIRECTION",
  "PDPP_DCR_INITIAL_ACCESS_TOKENS",
  "PDPP_ENABLE_STREAM_PLAYGROUND",
  "PDPP_REFERENCE_REVISION",
  "VERCEL",
]

function fail(message) {
  throw new Error(`[ensure-console-stack] ${message}`)
}

function validateProfile(profile) {
  if (typeof profile !== "string" || !/^[A-Za-z0-9._-]+$/.test(profile)) {
    fail(`invalid Tauri profile: ${JSON.stringify(profile)}`)
  }
  return profile
}

export function parseArgs(argv, env = process.env) {
  let profile = env.TAURI_PROFILE || DEFAULT_PROFILE
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--profile") {
      profile = argv[index + 1]
      index += 1
    } else {
      fail(`unknown argument: ${argument}`)
    }
  }
  return { profile: validateProfile(profile) }
}

function runConsoleBuild({
  projectRoot,
  spawn = spawnSync,
  env = process.env,
}) {
  const result = spawn("npm", ["run", "build", "--workspace=apps/console"], {
    cwd: projectRoot,
    env: { ...env, NODE_ENV: "production" },
    shell: false,
    stdio: "inherit",
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    fail(`console build exited with status ${result.status ?? "unknown"}`)
  }
}

function requireDirectory(directory, label) {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    fail(`${label} is missing: ${directory}`)
  }
}

function findServer(standaloneDirectory) {
  for (const candidate of ["apps/console/server.js", "server.js"]) {
    const serverPath = join(standaloneDirectory, candidate)
    if (existsSync(serverPath) && lstatSync(serverPath).isFile()) {
      return candidate
    }
  }
  fail(`Next standalone server.js was not found under ${standaloneDirectory}`)
}

function toPosixPath(value) {
  return value.split(sep).join("/")
}

function walkFiles(directory, prefix = "") {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(absolutePath, relativePath))
    } else if (entry.isFile()) {
      files.push({ absolutePath, relativePath: toPosixPath(relativePath) })
    } else {
      fail(`unsupported staged entry: ${absolutePath}`)
    }
  }
  return files
}

function hashFile(filePath) {
  return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`
}

function writeLauncher(stageDirectory, serverRelativePath) {
  const launcher = `#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const stageDirectory = dirname(fileURLToPath(import.meta.url))
const serverPath = resolve(stageDirectory, ${JSON.stringify(serverRelativePath)})
const child = spawn(process.execPath, [serverPath], {
  cwd: dirname(serverPath),
  env: { ...process.env, NODE_ENV: "production" },
  stdio: "inherit",
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal))
}

child.once("error", (error) => {
  console.error(error)
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1)
})
`
  const launcherPath = join(stageDirectory, "launch.mjs")
  writeFileSync(launcherPath, launcher, { mode: 0o755 })
  chmodSync(launcherPath, 0o755)
}

function writeManifest(stageDirectory, profile, serverRelativePath) {
  const hashes = {}
  for (const file of walkFiles(stageDirectory)) {
    if (file.relativePath === "manifest.json") continue
    hashes[file.relativePath] = hashFile(file.absolutePath)
  }
  const manifest = {
    schemaVersion: 1,
    profile,
    launcher: "launch.mjs",
    server: toPosixPath(serverRelativePath),
    runtimeEnv: [...CONSOLE_RUNTIME_ENV],
    hashes,
  }
  writeFileSync(
    join(stageDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

export function stageConsoleStack({
  projectRoot = PROJECT_ROOT,
  profile = DEFAULT_PROFILE,
  build = true,
  spawn = spawnSync,
  env = process.env,
} = {}) {
  const root = resolve(projectRoot)
  const validatedProfile = validateProfile(profile)
  if (build) {
    runConsoleBuild({ projectRoot: root, spawn, env })
  }

  const consoleDirectory = join(root, "apps", "console")
  const standaloneDirectory = join(consoleDirectory, ".next", "standalone")
  const staticDirectory = join(consoleDirectory, ".next", "static")
  const publicDirectory = join(consoleDirectory, "public")
  requireDirectory(standaloneDirectory, "Next standalone output")
  requireDirectory(staticDirectory, "Next static output")
  requireDirectory(publicDirectory, "console public output")

  const serverRelativePath = findServer(standaloneDirectory)
  const runtimeRelativeDirectory = dirname(serverRelativePath)
  const targetDirectory = join(
    root,
    ...STAGE_DIRECTORY.slice(0, 2),
    validatedProfile,
    ...STAGE_DIRECTORY.slice(2)
  )
  const targetParent = dirname(targetDirectory)
  mkdirSync(targetParent, { recursive: true })
  const temporaryDirectory = mkdtempSync(join(targetParent, ".console-stage-"))

  try {
    cpSync(standaloneDirectory, temporaryDirectory, { recursive: true })
    const stagedRuntimeDirectory = join(
      temporaryDirectory,
      runtimeRelativeDirectory
    )
    cpSync(staticDirectory, join(stagedRuntimeDirectory, ".next", "static"), {
      recursive: true,
    })
    cpSync(publicDirectory, join(stagedRuntimeDirectory, "public"), {
      recursive: true,
    })
    writeLauncher(temporaryDirectory, serverRelativePath)
    writeManifest(temporaryDirectory, validatedProfile, serverRelativePath)
    rmSync(targetDirectory, { force: true, recursive: true })
    renameSync(temporaryDirectory, targetDirectory)
  } catch (error) {
    rmSync(temporaryDirectory, { force: true, recursive: true })
    throw error
  }

  return {
    manifestPath: join(targetDirectory, "manifest.json"),
    profile: validatedProfile,
    serverPath: join(targetDirectory, serverRelativePath),
    stageDirectory: targetDirectory,
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const { profile } = parseArgs(process.argv.slice(2))
  const result = stageConsoleStack({ profile })
  console.log(
    `[ensure-console-stack] staged console at ${result.stageDirectory}`
  )
}
