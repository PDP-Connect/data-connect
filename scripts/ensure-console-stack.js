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
  readlinkSync,
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

// The console reads connector manifest JSON from this package's installed
// layout via dynamic fs paths (readdir over a resolved package root), not a
// static import, so Next's standalone output tracer never bundles it. Copy
// it into the staged node_modules explicitly so the packaged app is
// self-contained and does not need a monorepo checkout to find manifests.
const CONNECTOR_MANIFEST_PACKAGE = join(
  "node_modules",
  "@pdpp",
  "polyfill-connectors"
)

// resolve-connector-icon-simple-icons.ts reads this package the same way —
// dynamic fs paths against a resolved install root, not a static import — so
// it hits the identical standalone-tracing gap and needs the same explicit
// copy. Icons are looked up by name once a manifest's own bundled icon is
// absent (see NOTICE for the third-party-brand posture this vendors under).
const SIMPLE_ICONS_PACKAGE = join("node_modules", "simple-icons")

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
  const result = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "--workspace=apps/console"],
    {
      cwd: projectRoot,
      env: { ...env, NODE_ENV: "production" },
      shell: process.platform === "win32",
      stdio: "inherit",
    }
  )
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

function stageConnectorManifestsPackage(root, stagedRuntimeDirectory) {
  const sourcePackageDirectory = join(root, CONNECTOR_MANIFEST_PACKAGE)
  requireDirectory(
    sourcePackageDirectory,
    "connector manifests package (@pdpp/polyfill-connectors)"
  )
  const sourceManifestsDirectory = join(sourcePackageDirectory, "manifests")
  requireDirectory(
    sourceManifestsDirectory,
    "connector manifests directory"
  )
  const targetPackageDirectory = join(
    stagedRuntimeDirectory,
    CONNECTOR_MANIFEST_PACKAGE
  )
  mkdirSync(targetPackageDirectory, { recursive: true })
  // Stage only what connector-manifests-dir.ts needs to locate and read the
  // catalog: package.json (root detection) and manifests/ (the catalog
  // itself). The package's own node_modules/bin/connectors are for running
  // collection, not for listing the catalog, and dragging them along pulls
  // in symlinked binaries (e.g. patchright) the staging manifest hasher
  // can't walk.
  cpSync(
    join(sourcePackageDirectory, "package.json"),
    join(targetPackageDirectory, "package.json")
  )
  cpSync(sourceManifestsDirectory, join(targetPackageDirectory, "manifests"), {
    recursive: true,
  })
}

function stageSimpleIconsPackage(root, stagedRuntimeDirectory) {
  const sourcePackageDirectory = join(root, SIMPLE_ICONS_PACKAGE)
  if (!existsSync(sourcePackageDirectory)) {
    // simple-icons is the layer-2 vendored-icon lookup, not a hard
    // dependency of the console booting: a manifest without a bundled icon
    // (layer 1) and no simple-icons match (layer 2) still renders the
    // deterministic Monogram (layer 3). Degrade quietly rather than failing
    // the whole stage.
    return
  }
  const targetPackageDirectory = join(stagedRuntimeDirectory, SIMPLE_ICONS_PACKAGE)
  mkdirSync(targetPackageDirectory, { recursive: true })
  // Stage only what resolve-connector-icon-simple-icons.ts needs: package.json
  // (root detection), data/simple-icons.json (slug lookup), and icons/ (the
  // SVGs themselves). Skip the .mjs/.js/.d.ts module entrypoints — nothing
  // here imports simple-icons as a module.
  cpSync(
    join(sourcePackageDirectory, "package.json"),
    join(targetPackageDirectory, "package.json")
  )
  cpSync(
    join(sourcePackageDirectory, "data"),
    join(targetPackageDirectory, "data"),
    { recursive: true }
  )
  cpSync(
    join(sourcePackageDirectory, "icons"),
    join(targetPackageDirectory, "icons"),
    { recursive: true }
  )
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

/**
 * Find PIDs of any running process whose current working directory resolves
 * inside `targetDirectory`, using `/proc/<pid>/cwd` (Linux only -- macOS and
 * Windows have no equivalent without a new dependency, and are silently
 * skipped: see this function's caller for why that gap is acceptable).
 *
 * Confirmed live, 2026-09-19: this staging step used to `rmSync` +
 * `renameSync` the target directory unconditionally, which is atomic at the
 * filesystem level but still pulls the directory out from under any
 * already-running server process whose `cwd` is inside it -- the OS keeps
 * the process alive against the now-unlinked inode (its `cwd` shows
 * `(deleted)`), so it keeps serving stale server-rendered HTML from memory
 * while every static asset request 404s, since Next's dev/standalone server
 * reads its build manifest and static-asset expectations once at boot and
 * never re-reads them (see the `nextjs-deployment` research-corpus entry on
 * version skew: the fix is one immutable build directory per process plus an
 * atomic process/front-door cutover, never patching files under a live
 * server). This app's normal boot sequence never hits this -- staging always
 * runs once, before the Tauri app is launched (`beforeDevCommand`/
 * `beforeBuildCommand`), so there is no live process to collide with. It
 * reproduces only when this script re-runs while a PREVIOUSLY staged console
 * process is still running against the same fixed target path, i.e. an
 * iterative rebuild against an already-launched app -- exactly what happened
 * here.
 */
export function findProcessesUsingDirectory(targetDirectory) {
  if (process.platform !== "linux") {
    return []
  }
  const procDirectory = "/proc"
  if (!existsSync(procDirectory)) {
    return []
  }
  const resolvedTarget = resolve(targetDirectory)
  const pids = []
  let entries
  try {
    entries = readdirSync(procDirectory, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    let cwd
    try {
      cwd = readlinkSync(join(procDirectory, entry.name, "cwd"))
    } catch {
      // The process exited between readdir and readlink, or this process's
      // /proc entry is not readable (permissions) -- either way, not a
      // process this script can or needs to act on.
      continue
    }
    if (cwd === resolvedTarget || cwd.startsWith(`${resolvedTarget}${sep}`)) {
      pids.push(Number(entry.name))
    }
  }
  return pids
}

/**
 * Stop any process still running from inside `targetDirectory` before it is
 * removed/replaced, so a live rebuild never leaves a server running against
 * a directory that no longer exists on disk (see
 * `findProcessesUsingDirectory`'s doc comment for the live incident this
 * fixes). SIGTERM only -- this mirrors the same graceful-stop-then-timeout
 * shape `StopPolicy` uses on the Rust side (`process_supervisor.rs`) rather
 * than jumping straight to SIGKILL, since a `next-server` process may be
 * mid-request. A best-effort safety net for the dev/rebuild loop, not a
 * substitute for the Tauri supervisor's own lifecycle management of the
 * process IT started -- this only catches an ORPHANED process from a stage
 * directory whose owning Tauri app is no longer tracking it (e.g. a
 * previous dev session, or an external rebuild against a directory the
 * current process still has a handle open on).
 */
function stopProcessesUsingDirectory(targetDirectory) {
  for (const pid of findProcessesUsingDirectory(targetDirectory)) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // Already exited, or not ours to signal (EPERM) -- either way there
      // is nothing more this script can safely do about it.
    }
  }
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
    stageConnectorManifestsPackage(root, stagedRuntimeDirectory)
    stageSimpleIconsPackage(root, stagedRuntimeDirectory)
    writeLauncher(temporaryDirectory, serverRelativePath)
    writeManifest(temporaryDirectory, validatedProfile, serverRelativePath)
    // Stop any orphaned process still serving from the directory this rename
    // is about to replace -- see `stopProcessesUsingDirectory`'s doc comment.
    // A brief settle wait lets SIGTERM actually take effect (asynchronous;
    // this whole function is sync) before the swap, without blocking the
    // common case (nothing running there) more than the process-scan itself
    // costs.
    if (existsSync(targetDirectory)) {
      stopProcessesUsingDirectory(targetDirectory)
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 200)"])
    }
    rmSync(targetDirectory, { force: true, recursive: true })
    renameSync(temporaryDirectory, targetDirectory)
  } catch (error) {
    rmSync(temporaryDirectory, { force: true, recursive: true })
    throw error
  }

  // Post-stage assertion: a staged console with an empty or missing
  // manifest catalog is the worst failure mode (a silent empty Add-source
  // list that only surfaces as a 500 once the console is already running).
  // Verify against the final targetDirectory, not the pre-rename temp copy,
  // so this also catches a corrupted rename on filesystems with non-atomic
  // directory replace semantics.
  const stagedManifestsDirectory = join(
    targetDirectory,
    runtimeRelativeDirectory,
    CONNECTOR_MANIFEST_PACKAGE,
    "manifests"
  )
  requireDirectory(stagedManifestsDirectory, "staged connector manifests directory")
  const stagedManifestCount = readdirSync(stagedManifestsDirectory).filter((entry) =>
    entry.endsWith(".json")
  ).length
  if (stagedManifestCount === 0) {
    fail(
      `staged connector manifests directory is empty: ${stagedManifestsDirectory}`
    )
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
