#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  KEEP_GENERATIONS,
  collectOldStageGenerations,
  installStageGeneration,
  publishStageGeneration,
} from "./stage-generations.js"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROJECT_ROOT = resolve(SCRIPT_DIR, "..")
const DEFAULT_PROFILE = "release"
const LOCAL_PACKAGES = [
  ["@pdpp/collector-runtime", "packages/collector-runtime"],
  ["@pdpp/connector-protocol", "packages/connector-protocol"],
  ["@pdpp/display", "reference-implementation/vendor/display"],
  ["@pdpp/cli", "reference-implementation/vendor/cli"],
  ["@pdpp/read-core", "reference-implementation/vendor/read-core"],
  ["@pdpp/mcp-server", "reference-implementation/vendor/mcp-server"],
]
const RI_PACKAGE_FILES = [
  "reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz",
  "reference-implementation/vendor/pdpp-reference-contract-0.1.0.tgz",
]

function fail(message) {
  throw new Error(`[ensure-reference-stack] ${message}`)
}

function validateProfile(profile) {
  if (typeof profile !== "string" || !/^[A-Za-z0-9._-]+$/.test(profile)) {
    fail(`invalid Tauri profile: ${JSON.stringify(profile)}`)
  }
  return profile
}

export function referenceStackRoot(
  projectRoot = DEFAULT_PROJECT_ROOT,
  profile = DEFAULT_PROFILE
) {
  return join(
    resolve(projectRoot),
    "src-tauri",
    "target",
    validateProfile(profile),
    "reference-stack",
    "ri"
  )
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    shell: options.shell ?? false,
    stdio: options.stdio || "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with status ${result.status}`)
  }
  return result.stdout || ""
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

function copyTree(source, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, {
    dereference: true,
    filter: entry => {
      const relativePath = relative(source, entry)
      return !relativePath.split(/[\\/]/).includes("node_modules")
    },
    force: true,
    recursive: true,
  })
}

function copyDereferencedTree(source, destination) {
  const sourceStats = statSync(source)
  if (sourceStats.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source)) {
      copyDereferencedTree(join(source, entry), join(destination, entry))
    }
    return
  }
  if (sourceStats.isFile()) {
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    chmodSync(destination, sourceStats.mode)
    return
  }
  fail(`unsupported staged entry: ${source}`)
}

function assertNoSymlinks(root, current = root) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const filePath = join(current, entry.name)
    if (lstatSync(filePath).isSymbolicLink()) {
      fail(`staged RI contains a symbolic link: ${relative(root, filePath)}`)
    }
    if (entry.isDirectory()) assertNoSymlinks(root, filePath)
  }
}

function walkFiles(
  root,
  { current = root, skipNodeModules = false, skipDist = false, output = [] } = {}
) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )) {
    // Prune before recursing, not after: skipNodeModules avoids walking a
    // dependency tree only to discard it. stagedFileHashes needs the real
    // staged node_modules, so it omits skipNodeModules. skipDist likewise
    // excludes build output (e.g. tsc's dist/, including dist/.tsbuildinfo,
    // which is not byte-stable across two consecutive builds of unchanged
    // source): sourceInputFiles must hash only source, not the build's own
    // prior output, or the recipe rebuilds its own cache key out from under
    // itself every time buildWorkspacePackages runs.
    if (skipNodeModules && entry.name === "node_modules") continue
    if (skipDist && entry.name === "dist") continue
    const filePath = join(current, entry.name)
    const fileStats = statSync(filePath)
    if (fileStats.isDirectory())
      walkFiles(root, { current: filePath, skipNodeModules, skipDist, output })
    else if (fileStats.isFile()) output.push(filePath)
  }
  return output
}

function sourceInputFiles(projectRoot) {
  const roots = [
    join(projectRoot, "reference-implementation"),
    join(projectRoot, "packages", "collector-runtime"),
    join(projectRoot, "packages", "connector-protocol"),
    join(projectRoot, "reference-implementation", "vendor", "display"),
    join(projectRoot, "reference-implementation", "vendor", "cli"),
    join(projectRoot, "reference-implementation", "vendor", "read-core"),
    join(projectRoot, "reference-implementation", "vendor", "mcp-server"),
  ]
  return [
    join(projectRoot, "package.json"),
    join(projectRoot, "package-lock.json"),
    // The recipe itself is a behavior-affecting input: changing it must
    // invalidate any cache built under the old recipe.
    join(projectRoot, "scripts", "ensure-reference-stack.js"),
    join(projectRoot, "scripts", "stage-generations.js"),
    ...roots.flatMap(root =>
      existsSync(root)
        ? walkFiles(root, { skipNodeModules: true, skipDist: true })
        : []
    ),
  ]
    .filter(
      filePath =>
        existsSync(filePath) &&
        !filePath.split(/[\\/]/).includes("node_modules")
    )
    .sort()
}

export function sourceInputHash(projectRoot) {
  const hash = createHash("sha256")
  for (const filePath of sourceInputFiles(projectRoot)) {
    hash.update(relative(projectRoot, filePath).split("\\").join("/"))
    hash.update("\0")
    hash.update(sha256(filePath))
    hash.update("\n")
  }
  return hash.digest("hex")
}

function targetFromEnvironment(env = process.env) {
  return env.TAURI_ENV_TARGET_TRIPLE || env.TAURI_ENV_TARGET || env.TARGET
}

export function manifestTarget(target, env = process.env) {
  return (
    target ||
    targetFromEnvironment(env) ||
    `${process.platform}-${process.arch}`
  )
}

export function referenceGenerationId(manifest) {
  return createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")
    .slice(0, 12)
}

function manifestProfile(profile) {
  return validateProfile(
    profile ||
      process.env.TAURI_PROFILE ||
      process.env.PROFILE ||
      DEFAULT_PROFILE
  )
}

function stagedFileHashes(root) {
  return walkFiles(root)
    .filter(filePath => relative(root, filePath) !== "manifest.json")
    .map(filePath => {
      const path = relative(root, filePath).split("\\").join("/")
      return {
        path,
        sha256: sha256(filePath),
        size: statSync(filePath).size,
      }
    })
}

function nativeArtifactCandidates() {
  const sqliteExtension =
    process.platform === "win32"
      ? "dll"
      : process.platform === "darwin"
        ? "dylib"
        : "so"
  return {
    "better-sqlite3": [
      "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      `node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`,
    ],
    "sqlite-vec": [
      `node_modules/sqlite-vec-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}/vec0.${sqliteExtension}`,
      `node_modules/sqlite-vec/build/Release/vec0.${sqliteExtension}`,
    ],
  }
}

function nativeArtifactPaths(root) {
  return Object.fromEntries(
    Object.entries(nativeArtifactCandidates()).map(([name, candidates]) => {
      const path = candidates.find(candidate =>
        existsSync(join(root, candidate))
      )
      return [name, path || candidates[0]]
    })
  )
}

function nodeSidecarCandidates(projectRoot) {
  const binaryDir = join(projectRoot, "src-tauri", "binaries")
  if (!existsSync(binaryDir)) return []
  return readdirSync(binaryDir)
    .filter(name => name.startsWith("pdpp-node-") && !name.endsWith("-LICENSE"))
    .map(name => join(binaryDir, name))
}

function defaultNodeBinary(projectRoot) {
  const explicit = process.env.PDPP_NODE_BINARY
  if (explicit) return resolve(projectRoot, explicit)
  const unqualified = join(projectRoot, "src-tauri", "binaries", "pdpp-node")
  if (existsSync(unqualified)) return unqualified
  const candidates = nodeSidecarCandidates(projectRoot)
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    const target = targetFromEnvironment()
    const matching = candidates.find(
      candidate => target && candidate.includes(target)
    )
    if (matching) return matching
  }
  fail(
    "No target-native pdpp-node sidecar found; run scripts/stage-pdpp-node.mjs first or set PDPP_NODE_BINARY"
  )
}

function npmCommand(nodeBinary) {
  const npmCli = process.env.npm_execpath
  if (npmCli && existsSync(npmCli)) return [nodeBinary, npmCli]
  return [process.platform === "win32" ? "npm.cmd" : "npm"]
}

function runNpm(nodeBinary, args, options) {
  const [command, ...prefix] = npmCommand(nodeBinary)
  return run(command, [...prefix, ...args], {
    ...options,
    shell: process.platform === "win32" && command === "npm.cmd",
  })
}

function ensureHostDependencies(projectRoot, nodeBinary) {
  if (existsSync(join(projectRoot, "node_modules", ".bin", "tsx"))) return
  console.log("[ensure-reference-stack] Installing workspace dependencies")
  runNpm(
    nodeBinary,
    ["ci", "--allow-git=all", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    }
  )
}

function buildWorkspacePackages(projectRoot, nodeBinary) {
  const workspaces = [
    "packages/connector-protocol",
    "packages/collector-runtime",
    "reference-implementation/vendor/read-core",
    "reference-implementation/vendor/mcp-server",
  ]
  runNpm(
    nodeBinary,
    [
      "run",
      "build",
      ...workspaces.flatMap(workspace => ["--workspace", workspace]),
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    }
  )
}

function localPackageSpecifier(packageName) {
  return `file:vendor-packages/${packageName.replace("@pdpp/", "")}`
}

function createStagedPackageJson(projectRoot, stageRoot) {
  const riPackage = JSON.parse(
    readFileSync(
      join(projectRoot, "reference-implementation", "package.json"),
      "utf8"
    )
  )
  const dependencies = { ...riPackage.dependencies }
  const rootPackage = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8")
  )
  dependencies.tsx = rootPackage.devDependencies?.tsx || "^4.23.13"
  dependencies["@pdpp/polyfill-connectors"] =
    "file:reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz"
  dependencies["@pdpp/reference-contract"] =
    "file:reference-implementation/vendor/pdpp-reference-contract-0.1.0.tgz"
  for (const [packageName] of LOCAL_PACKAGES) {
    dependencies[packageName] = localPackageSpecifier(packageName)
  }
  return {
    name: "pdpp-reference-stack-ri-runtime",
    private: true,
    type: "module",
    engines: { node: ">=22.14.0 <24" },
    dependencies,
  }
}

function copyRuntimeSources(projectRoot, stageRoot) {
  copyTree(
    join(projectRoot, "reference-implementation"),
    join(stageRoot, "reference-implementation")
  )
  for (const [, sourceRelativePath] of LOCAL_PACKAGES) {
    const source = join(projectRoot, sourceRelativePath)
    const destination = join(
      stageRoot,
      "vendor-packages",
      JSON.parse(
        readFileSync(join(source, "package.json"), "utf8")
      ).name.replace("@pdpp/", "")
    )
    copyTree(source, destination)
  }
}

// better-sqlite3 and better-sqlite3-multiple-ciphers each ship a prebuilds/
// directory with every platform's binary. Rebuilding better-sqlite3 from
// source below (npm rebuild) only adds the current platform's build/Release
// output — it does not delete the package's own shipped prebuilds/, which is
// where the foreign-platform artifacts actually sit (sqlite-vec is not
// affected: its per-platform builds are separate npm packages, e.g.
// sqlite-vec-linux-x64, so npm never installs a musl one on this host).
// Tauri's Linux AppImage bundler (linuxdeploy) walks the ELF dependencies of
// every staged .node file and hard-fails the whole bundle on a musl
// prebuild's unresolvable libc.musl-x86_64.so.1 reference, even though
// nothing loads that file on this glibc target. Delete every prebuild
// except the one this staged tree will actually run.
const PACKAGES_WITH_PLATFORM_PREBUILDS = [
  "better-sqlite3",
  "better-sqlite3-multiple-ciphers",
]

export function pruneForeignPlatformPrebuilds(
  stageRoot,
  { platform = process.platform, arch = process.arch } = {}
) {
  const keep = `${platform}-${arch}.node`
  for (const packageName of PACKAGES_WITH_PLATFORM_PREBUILDS) {
    const prebuildsDir = join(
      stageRoot,
      "node_modules",
      packageName,
      "prebuilds"
    )
    if (!existsSync(prebuildsDir)) continue
    for (const entry of readdirSync(prebuildsDir)) {
      if (entry !== keep) rmSync(join(prebuildsDir, entry), { force: true })
    }
  }

  // The napi-rs canvas package includes both glibc and musl addons for the
  // current Linux architecture. linuxdeploy treats the musl addon as a Linux
  // ELF and fails when ldd cannot resolve its musl loader on our glibc target.
  // The matching GNU addon is the one loaded by the shipped Linux runtime.
  if (platform === "linux") {
    rmSync(
      join(stageRoot, "node_modules", "@napi-rs", `canvas-linux-${arch}-musl`),
      { force: true, recursive: true }
    )

    const napiRoot = join(
      stageRoot,
      "node_modules",
      "onnxruntime-node",
      "bin"
    )
    if (existsSync(napiRoot)) {
      for (const napiVersion of readdirSync(napiRoot)) {
        const versionRoot = join(napiRoot, napiVersion)
        if (!statSync(versionRoot).isDirectory()) continue
        for (const runtimePlatform of readdirSync(versionRoot)) {
          const platformRoot = join(versionRoot, runtimePlatform)
          if (!statSync(platformRoot).isDirectory()) continue
          if (runtimePlatform !== platform) {
            rmSync(platformRoot, { force: true, recursive: true })
            continue
          }
          for (const runtimeArch of readdirSync(platformRoot)) {
            if (runtimeArch !== arch) {
              rmSync(join(platformRoot, runtimeArch), {
                force: true,
                recursive: true,
              })
            }
          }
        }
      }
    }
  }
}

// npm installs every optional platform package whose os/cpu match, even when
// its package.json "libc" field names another C library (for example
// @img/sharp-linuxmusl-x64 and @napi-rs/canvas-linux-x64-musl on a glibc
// host). linuxdeploy then fails the AppImage on the unresolvable
// libc.musl-x86_64.so.1 reference, as with the better-sqlite3 prebuilds above.
// Delete top-level packages that declare a libc other than the host's.
function hostLibc() {
  if (process.platform !== "linux") return null
  return process.report.getReport().header.glibcVersionRuntime
    ? "glibc"
    : "musl"
}

export function pruneForeignLibcPackages(stageRoot, libc = hostLibc()) {
  if (!libc) return
  const nodeModules = join(stageRoot, "node_modules")
  if (!existsSync(nodeModules)) return
  const packageDirs = []
  for (const entry of readdirSync(nodeModules)) {
    if (!entry.startsWith("@")) {
      packageDirs.push(join(nodeModules, entry))
      continue
    }
    for (const scoped of readdirSync(join(nodeModules, entry))) {
      packageDirs.push(join(nodeModules, entry, scoped))
    }
  }
  for (const packageDir of packageDirs) {
    const manifestPath = join(packageDir, "package.json")
    if (!existsSync(manifestPath)) continue
    const declared = JSON.parse(readFileSync(manifestPath, "utf8")).libc
    if (Array.isArray(declared) && !declared.includes(libc)) {
      rmSync(packageDir, { recursive: true, force: true })
    }
  }
}

export function installStagedDependencies(projectRoot, stageRoot, nodeBinary) {
  writeFileSync(
    join(stageRoot, "package.json"),
    `${JSON.stringify(createStagedPackageJson(projectRoot, stageRoot), null, 2)}\n`
  )
  // Pin the stage to the workspace's already-resolved versions instead of
  // letting npm re-resolve semver ranges against the live registry: the
  // cache's source-input hash does not otherwise change when a transitive
  // dependency publishes a new version matching an existing range.
  copyFileSync(
    join(projectRoot, "package-lock.json"),
    join(stageRoot, "package-lock.json")
  )
  runNpm(
    nodeBinary,
    [
      "install",
      "--allow-git=all",
      "--ignore-scripts",
      "--omit=dev",
      "--install-links",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: stageRoot,
      env: {
        ...process.env,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    }
  )
  runNpm(
    nodeBinary,
    [
      "rebuild",
      "better-sqlite3",
      "sqlite-vec",
      "patchright",
      "patchright-core",
      "--dangerously-allow-all-scripts",
    ],
    {
      cwd: stageRoot,
      env: {
        ...process.env,
        npm_config_build_from_source: "true",
        npm_config_runtime: "node",
        npm_config_target:
          process.env.PDPP_NODE_VERSION || nodeVersion(nodeBinary),
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    }
  )
  pruneForeignPlatformPrebuilds(stageRoot)
  pruneForeignLibcPackages(stageRoot)
}

function nodeVersion(nodeBinary) {
  const output = run(nodeBinary, ["-p", "process.versions.node"], {
    stdio: "pipe",
  })
  return output.trim()
}

function nodeAbi(nodeBinary) {
  const output = run(nodeBinary, ["-p", "process.versions.modules"], {
    stdio: "pipe",
  })
  return output.trim()
}

export function launchScript() {
  return `#!/usr/bin/env node
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const root = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(process.env.PDPP_DATA_DIR || process.env.PDPP_REFERENCE_DATA_DIR || join(root, "data"))
const dbPath = resolve(process.env.PDPP_DB_PATH || join(dataDir, "pdpp.sqlite"))
mkdirSync(dataDir, { recursive: true })
const child = spawn(process.execPath, ["--import", "tsx", "reference-implementation/server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    AS_PORT: process.env.AS_PORT || "0",
    RS_PORT: process.env.RS_PORT || "0",
    PDPP_DB_PATH: dbPath,
    PDPP_BIND_HOST: process.env.PDPP_BIND_HOST || "127.0.0.1",
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED: process.env.PDPP_EMBEDDING_DOWNLOAD_ALLOWED || "0",
    PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  },
  stdio: "inherit",
})

let stopping = false
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    child.kill(signal)
  })
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
`
}

function writeLaunchScript(stageRoot) {
  const launcherPath = join(stageRoot, "launch.mjs")
  writeFileSync(launcherPath, launchScript(), { mode: 0o755 })
}

function assertNativeFiles(stageRoot) {
  for (const [name, relativePath] of Object.entries(
    nativeArtifactPaths(stageRoot)
  )) {
    if (!existsSync(join(stageRoot, relativePath))) {
      fail(`native module ${name} is missing at ${relativePath}`)
    }
  }
  if (
    !existsSync(join(stageRoot, "node_modules", "patchright", "package.json"))
  ) {
    fail("Patchright is missing from the staged dependency tree")
  }
}

export function buildManifest({
  projectRoot,
  stageRoot,
  nodeBinary,
  target,
  profile,
}) {
  const lockPath = join(projectRoot, "package-lock.json")
  const version = nodeVersion(nodeBinary)
  const nativePaths = nativeArtifactPaths(stageRoot)
  return {
    schemaVersion: 1,
    target: manifestTarget(target),
    profile: manifestProfile(profile),
    node: {
      abi: nodeAbi(nodeBinary),
      version,
    },
    dependencyLock: {
      path: "source-package-lock.json",
      sha256: sha256(lockPath),
    },
    inputs: { sha256: sourceInputHash(projectRoot) },
    embedding: {
      downloadAllowed: false,
      model: "lexical-only-until-a-model-is-bundled-or-cached",
    },
    nativeModules: Object.fromEntries(
      Object.entries(nativePaths).map(([name, relativePath]) => [
        name,
        {
          abi: nodeAbi(nodeBinary),
          path: relativePath,
          sha256: sha256(join(stageRoot, relativePath)),
        },
      ])
    ),
    files: stagedFileHashes(stageRoot),
  }
}

export function verifyReferenceStackRoot(stageRoot) {
  const requiredPaths = [
    "launch.mjs",
    "manifest.json",
    "reference-implementation/server/index.ts",
    "node_modules/tsx/package.json",
    "node_modules/patchright/package.json",
    ...Object.values(nativeArtifactPaths(stageRoot)),
  ]
  const missing = requiredPaths.filter(
    path => !existsSync(join(stageRoot, path))
  )
  if (missing.length > 0) fail(`staged RI is incomplete: ${missing.join(", ")}`)
  const manifest = JSON.parse(
    readFileSync(join(stageRoot, "manifest.json"), "utf8")
  )
  const actualFiles = stagedFileHashes(stageRoot)
  if (JSON.stringify(manifest.files) !== JSON.stringify(actualFiles)) {
    fail("manifest file hashes do not match the staged root")
  }
  return manifest
}

function matchesReferenceGeneration(existingRoot, candidateRoot) {
  try {
    assertNoSymlinks(existingRoot)
    assertNoSymlinks(candidateRoot)
    const existingManifest = verifyReferenceStackRoot(existingRoot)
    const candidateManifest = verifyReferenceStackRoot(candidateRoot)
    return JSON.stringify(existingManifest) === JSON.stringify(candidateManifest)
  } catch {
    return false
  }
}

export function stageReferenceStack({
  projectRoot = DEFAULT_PROJECT_ROOT,
  outputRoot,
  nodeBinary = defaultNodeBinary(projectRoot),
  target,
  profile,
} = {}) {
  const resolvedProjectRoot = resolve(projectRoot)
  const resolvedTarget = manifestTarget(target)
  const resolvedProfile = manifestProfile(profile)
  const resolvedOutputRoot = resolve(
    outputRoot || referenceStackRoot(resolvedProjectRoot, resolvedProfile)
  )
  if (
    !existsSync(
      join(
        resolvedProjectRoot,
        "reference-implementation",
        "server",
        "index.ts"
      )
    )
  ) {
    fail("reference-implementation/server/index.ts is missing")
  }
  if (!existsSync(join(resolvedProjectRoot, "package-lock.json"))) {
    fail("package-lock.json is required for deterministic staging")
  }

  const version = nodeVersion(nodeBinary)
  if (existsSync(join(resolvedOutputRoot, "manifest.json"))) {
    const existingManifest = JSON.parse(
      readFileSync(join(resolvedOutputRoot, "manifest.json"), "utf8")
    )
    if (
      existingManifest.target === resolvedTarget &&
      existingManifest.profile === resolvedProfile &&
      existingManifest.node?.version === version &&
      existingManifest.inputs?.sha256 === sourceInputHash(resolvedProjectRoot)
    ) {
      // Matching inputs do not prove output integrity. Do not automatically
      // replace corrupt output: a live process may still be reading it.
      try {
        verifyReferenceStackRoot(resolvedOutputRoot)
      } catch (error) {
        fail(
          `staged root at ${resolvedOutputRoot} matches the expected build but failed integrity verification (${error instanceof Error ? error.message : error}). Stop the app using this directory, move it aside, then rerun to restage.`
        )
      }
      console.log(
        `[ensure-reference-stack] staged root is current: ${resolvedOutputRoot}`
      )
      return {
        manifest: existingManifest,
        reused: true,
        root: resolvedOutputRoot,
      }
    }
  }

  ensureHostDependencies(resolvedProjectRoot, nodeBinary)
  buildWorkspacePackages(resolvedProjectRoot, nodeBinary)

  const parent = dirname(resolvedOutputRoot)
  const temporaryRoot = join(parent, `.ri-staging-${process.pid}`)
  rmSync(temporaryRoot, { force: true, recursive: true })
  mkdirSync(temporaryRoot, { recursive: true })
  try {
    copyRuntimeSources(resolvedProjectRoot, temporaryRoot)
    copyFileSync(
      join(resolvedProjectRoot, "package-lock.json"),
      join(temporaryRoot, "source-package-lock.json")
    )
    for (const relativePath of RI_PACKAGE_FILES) {
      if (!existsSync(join(resolvedProjectRoot, relativePath)))
        fail(`missing ${relativePath}`)
    }
    installStagedDependencies(resolvedProjectRoot, temporaryRoot, nodeBinary)
    writeLaunchScript(temporaryRoot)
    assertNativeFiles(temporaryRoot)
    const manifest = buildManifest({
      nodeBinary,
      profile: resolvedProfile,
      projectRoot: resolvedProjectRoot,
      stageRoot: temporaryRoot,
      target,
    })
    writeFileSync(
      join(temporaryRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
    // Land this build in its deterministic immutable generation directory.
    // Reuse an existing directory only after its manifest and file hashes
    // match this candidate; never replace a possibly live generation.
    mkdirSync(parent, { recursive: true })
    // Source identity alone is not a generation identity: native modules,
    // Node ABI, profile, and target are part of the manifest too. Name the
    // immutable directory from the complete artifact description so builds
    // with identical source but different outputs never collide.
    const generationRoot = join(
      parent,
      `ri-${referenceGenerationId(manifest)}`
    )
    const generationCandidate = join(parent, `.ri-generation-${process.pid}`)
    rmSync(generationCandidate, { force: true, recursive: true })
    copyDereferencedTree(temporaryRoot, generationCandidate)
    assertNoSymlinks(generationCandidate)
    verifyReferenceStackRoot(generationCandidate)
    installStageGeneration(
      generationRoot,
      generationCandidate,
      matchesReferenceGeneration,
    )
    assertNoSymlinks(generationRoot)
    verifyReferenceStackRoot(generationRoot)
    publishStageGeneration(
      resolvedOutputRoot,
      generationRoot,
      matchesReferenceGeneration,
    )
    collectOldStageGenerations(parent, "ri", KEEP_GENERATIONS)
    return { manifest, reused: false, root: resolvedOutputRoot }
  } finally {
    rmSync(join(parent, `.ri-generation-${process.pid}`), {
      force: true,
      recursive: true,
    })
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === "--project-root") options.projectRoot = value
    else if (argv[index] === "--output-root") options.outputRoot = value
    else if (argv[index] === "--node-binary") options.nodeBinary = value
    else if (argv[index] === "--target") options.target = value
    else if (argv[index] === "--profile") options.profile = value
    else fail(`unknown argument: ${argv[index]}`)
    index += 1
  }
  return options
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = stageReferenceStack(parseArgs(process.argv.slice(2)))
    console.log(
      result.reused
        ? `[ensure-reference-stack] staged root is current: ${result.root}`
        : `[ensure-reference-stack] staged ${result.root}`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
