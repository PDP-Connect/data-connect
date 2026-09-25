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
  rmSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { isMainModule } from "./is-main-module.js"
import {
  KEEP_GENERATIONS,
  collectOldStageGenerations,
  findProcessesUsingDirectory,
  installStageGeneration,
  publishStageGeneration,
} from "./stage-generations.js"

const ROOT = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = dirname(ROOT)
const DEFAULT_PROFILE = "release"
const STAGE_DIRECTORY = ["src-tauri", "target", "reference-stack", "console"]
// Last segment of STAGE_DIRECTORY, reused to name this build's immutable
// generation directory (`console-<id>`) beside the stable `console` path.
const CONSOLE_STAGE_NAME = STAGE_DIRECTORY[STAGE_DIRECTORY.length - 1]

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
  "PDPP_ORIGIN_PROOF_KEY",
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

/** Diagnostic helper; an empty result cannot prove that a tree is unused. */
export { findProcessesUsingDirectory }

/**
 * A short, stable id for this build's content, taken from the manifest the
 * stage just wrote.
 *
 * The manifest already hashes every staged file, so the generation is
 * derived from what was actually produced rather than from a timestamp or a
 * counter: restaging identical content reuses the same generation directory
 * instead of growing a new one every rebuild, and two different builds can
 * never collide on one directory.
 */
function readGenerationId(stageDirectory) {
  const manifest = readFileSync(join(stageDirectory, "manifest.json"), "utf8")
  return createHash("sha256").update(manifest).digest("hex").slice(0, 12)
}

function matchesConsoleGeneration(existingDirectory, candidateDirectory) {
  try {
    const manifestPath = join(existingDirectory, "manifest.json")
    const candidateManifest = readFileSync(
      join(candidateDirectory, "manifest.json"),
      "utf8",
    )
    if (readFileSync(manifestPath, "utf8") !== candidateManifest) return false
    const hashes = JSON.parse(candidateManifest).hashes
    const expectedPaths = Object.keys(hashes).sort()
    const existingFiles = walkFiles(existingDirectory).filter(
      (file) => file.relativePath !== "manifest.json",
    )
    if (
      existingFiles.length !== expectedPaths.length ||
      existingFiles.some((file, index) => file.relativePath !== expectedPaths[index])
    ) {
      return false
    }
    return existingFiles.every(
      (file) => hashes[file.relativePath] === hashFile(file.absolutePath),
    )
  } catch {
    return false
  }
}

/**
 * Point the stable `console` path at `generationDirectory`.
 *
 * Deliberately a real directory rather than a symlink. Verified 2026-09-21:
 * `cpSync(..., { recursive: true })` PRESERVES a symlink instead of
 * following it, and `scripts/build-prod.js` and
 * `scripts/finalize-linux-appimage.js` both copy this exact path into the
 * packaged app that way -- so a symlinked `console` would ship a dangling
 * link inside the bundle. The Tauri bundler's own `resources` glob
 * (`target/release/reference-stack/console/`) has the same requirement.
 *
 * The stable copy keeps packaging paths unchanged. Publication moves the
 * previous tree aside so current processes retain its files.
 */
function publishGeneration(targetDirectory, generationDirectory) {
  // The shared publisher moves the old stable tree aside; it does not signal
  // the process using that tree.
  publishStageGeneration(
    targetDirectory,
    generationDirectory,
    matchesConsoleGeneration,
  )
}

/** Report retained generations; cleanup waits for cross-platform ownership proof. */
export function collectOldGenerations(targetParent, keep = KEEP_GENERATIONS) {
  return collectOldStageGenerations(targetParent, CONSOLE_STAGE_NAME, keep)
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

    // Install this build at its deterministic immutable generation path.
    // If that path already exists, reuse it only after verifying its manifest
    // and every file hash; never remove and recreate a possibly live tree.
    const generationDirectory = join(
      targetParent,
      `${CONSOLE_STAGE_NAME}-${readGenerationId(temporaryDirectory)}`
    )
    installStageGeneration(
      generationDirectory,
      temporaryDirectory,
      matchesConsoleGeneration,
    )
    publishGeneration(targetDirectory, generationDirectory)
    collectOldGenerations(targetParent, KEEP_GENERATIONS)
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
