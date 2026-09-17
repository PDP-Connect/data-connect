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

function walkFiles(root, current = root, output = []) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )) {
    const filePath = join(current, entry.name)
    const fileStats = statSync(filePath)
    if (fileStats.isDirectory()) walkFiles(root, filePath, output)
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
    ...roots.flatMap(root => (existsSync(root) ? walkFiles(root) : [])),
  ]
    .filter(
      filePath =>
        existsSync(filePath) &&
        !filePath.split(/[\\/]/).includes("node_modules")
    )
    .sort()
}

function sourceInputHash(projectRoot) {
  const hash = createHash("sha256")
  for (const filePath of sourceInputFiles(projectRoot)) {
    hash.update(relative(projectRoot, filePath).split("\\").join("/"))
    hash.update("\0")
    hash.update(sha256(filePath))
    hash.update("\n")
  }
  return hash.digest("hex")
}

function manifestTarget(target) {
  return (
    target ||
    process.env.TAURI_ENV_TARGET ||
    process.env.TARGET ||
    `${process.platform}-${process.arch}`
  )
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
    const target = process.env.TAURI_ENV_TARGET || process.env.TARGET
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

function installStagedDependencies(projectRoot, stageRoot, nodeBinary) {
  writeFileSync(
    join(stageRoot, "package.json"),
    `${JSON.stringify(createStagedPackageJson(projectRoot, stageRoot), null, 2)}\n`
  )
  runNpm(
    nodeBinary,
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--install-links",
      "--no-package-lock",
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
    rmSync(resolvedOutputRoot, { force: true, recursive: true })
    mkdirSync(parent, { recursive: true })
    copyDereferencedTree(temporaryRoot, resolvedOutputRoot)
    assertNoSymlinks(resolvedOutputRoot)
    verifyReferenceStackRoot(resolvedOutputRoot)
    return { manifest, reused: false, root: resolvedOutputRoot }
  } finally {
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
