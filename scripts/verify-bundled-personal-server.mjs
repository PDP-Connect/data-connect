#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { isMainModule } from "./is-main-module.js"

const REQUIRED_PATH_FRAGMENTS = [
  "connectors/lock.json",
  "connectors/collection-profiles/github-pdpp/profile/collection-profile.json",
  "connectors/collection-profiles/github-pdpp/dist/collection-profile.mjs",
  "connectors/collection-profiles/github-pdpp/provenance.json",
  "connectors/collection-profiles/chatgpt-pdpp/profile/collection-profile.json",
  "connectors/collection-profiles/chatgpt-pdpp/dist/collection-profile.mjs",
  "connectors/collection-profiles/chatgpt-pdpp/provenance.json",
  "licenses/pdpp-node-license",
  "personal-server/dist/personal-server",
  "personal-server/dist/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "playwright-runner/dist/playwright-runner",
  "pdpp-runtime/connector-loader.mjs",
  "pdpp-runtime/connector-loader-bootstrap.mjs",
  "pdpp-runtime/node_modules/p-queue/package.json",
  "pdpp-runtime/node_modules/p-queue/dist/index.js",
  "pdpp-runtime/node_modules/patchright/package.json",
  "pdpp-runtime/node_modules/patchright/index.mjs",
]

function fail(message) {
  throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`
    )
  }
  return result.stdout
}

function normalizeEntry(entry) {
  return entry.replaceAll("\\", "/").toLowerCase()
}

export function assertPackagedRuntime(entries, artifactName) {
  const platform = artifactPlatform(artifactName)
  const packagedPaths = new Set(
    entries.map(entry => packagedEntryPath(entry, platform))
  )
  const missing = expectedRuntimePaths(platform).filter(
    expectedPath => !packagedPaths.has(expectedPath)
  )

  if (missing.length > 0) {
    fail(
      `${artifactName} is missing packaged runtime files: ${missing.join(", ")}`
    )
  }
}

function artifactPlatform(artifactName) {
  const normalizedName = artifactName.toLowerCase()
  if (normalizedName.endsWith(".exe")) return "windows"
  if (normalizedName.endsWith(".dmg") || normalizedName.endsWith(".app"))
    return "macos"
  if (normalizedName.endsWith(".deb") || normalizedName.endsWith(".appimage"))
    return "linux"
  fail(`Cannot determine artifact platform from ${artifactName}`)
}

function expectedRuntimePaths(platform) {
  const root = {
    linux: "usr/lib/dataconnect/",
    macos: "contents/resources/",
    windows: "",
  }[platform]
  if (root === undefined) fail(`Unsupported runtime platform: ${platform}`)
  return REQUIRED_PATH_FRAGMENTS.map(fragment => {
    const executableSuffix =
      platform === "windows" &&
      (fragment.endsWith("personal-server/dist/personal-server") ||
        fragment.endsWith("playwright-runner/dist/playwright-runner"))
        ? ".exe"
        : ""
    return `${root}${fragment}${executableSuffix}`.toLowerCase()
  })
}

function packagedEntryPath(entry, platform) {
  if (platform === "windows") return windowsInstallerEntryPath(entry)
  const normalized = normalizeEntry(entry).trim()
  if (platform === "macos") return normalized
  const path = normalized.includes(" ")
    ? normalized.split(/\s+/).at(-1)
    : normalized
  return path.replace(/^\.\//, "")
}

export function assertPackagedNode(entries, artifactName, platform) {
  const expectedPath = {
    linux: "usr/bin/pdpp-node",
    macos: "contents/macos/pdpp-node",
    windows: "pdpp-node.exe",
  }[platform]
  if (!expectedPath) fail(`Unsupported Node sidecar platform: ${platform}`)
  const hasNode = entries.some(
    entry => packagedEntryPath(entry, platform) === expectedPath
  )
  if (!hasNode) {
    fail(`${artifactName} is missing its packaged Node.js sidecar`)
  }
}

export function assertPackagedBrowser(entries, artifactName, platform) {
  const expectedPrefix = {
    linux: "usr/lib/dataconnect/playwright-runner/dist/browsers/chromium-",
    macos: "contents/resources/playwright-runner/dist/browsers/chromium-",
    windows: "playwright-runner/dist/browsers/chromium-",
  }[platform]
  const executableNames = {
    linux: ["/chrome"],
    macos: [
      "/contents/macos/google chrome for testing",
      "/contents/macos/chromium",
    ],
    windows: ["/chrome.exe"],
  }[platform]
  if (!expectedPrefix || !executableNames)
    fail(`Unsupported browser platform: ${platform}`)

  const hasBrowserExecutable = entries
    .map(entry => packagedEntryPath(entry, platform))
    .some(entry => {
      return (
        entry.startsWith(expectedPrefix) &&
        executableNames.some(name => entry.endsWith(name))
      )
    })
  if (!hasBrowserExecutable) {
    fail(`${artifactName} is missing its packaged Chromium executable`)
  }
}

export function assertBinaryArchitecture(fileOutput, expectedArch, binaryName) {
  const architecturePattern =
    expectedArch === "arm64" ? /\barm64\b/i : /\bx86_64\b/i
  if (!architecturePattern.test(fileOutput)) {
    fail(
      `${binaryName} does not contain expected ${expectedArch} architecture: ${fileOutput}`
    )
  }
}

export function listDebEntries(artifact) {
  return run("dpkg-deb", ["--contents", artifact], {
    maxBuffer: 16 * 1024 * 1024,
  }).split("\n")
}

function listDirectoryEntries(root, relative = "") {
  const entries = []
  for (const entry of readdirSync(join(root, relative), {
    withFileTypes: true,
  })) {
    const child = join(relative, entry.name)
    entries.push(child)
    if (entry.isDirectory()) entries.push(...listDirectoryEntries(root, child))
  }
  return entries
}

function listAppImageEntries(artifact) {
  const extractionRoot = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), "dataconnect-appimage-")
  )
  try {
    run(artifact, ["--appimage-extract"], {
      cwd: extractionRoot,
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
    })
    const appDir = join(extractionRoot, "squashfs-root")
    if (!existsSync(appDir))
      fail(`${basename(artifact)} did not extract an AppDir`)
    return listDirectoryEntries(appDir)
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true })
  }
}

const WINDOWS_BROWSER_FRAGMENT = "playwright-runner/dist/browsers/chromium-"
const WINDOWS_BROWSER_EXECUTABLE = "/chrome.exe"
const WINDOWS_NODE_FILENAME = "pdpp-node.exe"
const WINDOWS_RUNTIME_PATHS = new Set(expectedRuntimePaths("windows"))
const COMMAND_ERROR_OUTPUT_LIMIT = 64 * 1024

function windowsInstallerEntryPath(entry) {
  // `7z l -ba` prefixes metadata, while Tauri's NSIS `/oname` sidecar is a
  // bare root entry. Compare that installed path, not the staged source name.
  return normalizeEntry(entry).trim().split(/\s+/).at(-1)
}

function appendBoundedOutput(output, chunk) {
  return `${output}${chunk}`.slice(-COMMAND_ERROR_OUTPUT_LIMIT)
}

export async function collectRelevantWindowsInstallerEntries(
  command,
  args,
  spawnProcess = spawn
) {
  const child = spawnProcess(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
  })
  const relevantEntries = new Map()
  let stderr = ""

  child.stderr.setEncoding("utf8")
  child.stderr.on("data", chunk => {
    stderr = appendBoundedOutput(stderr, chunk)
  })

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on("line", line => {
    const path = windowsInstallerEntryPath(line)
    const isRuntime = WINDOWS_RUNTIME_PATHS.has(path)
    const isNode = path === WINDOWS_NODE_FILENAME
    const isBrowser =
      path.startsWith(WINDOWS_BROWSER_FRAGMENT) &&
      path.endsWith(WINDOWS_BROWSER_EXECUTABLE)
    if (isRuntime || isNode || isBrowser) relevantEntries.set(path, line)
  })

  const processExited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit)
    child.once("close", code => {
      if (code !== 0) {
        rejectExit(new Error(`${command} ${args.join(" ")} failed: ${stderr}`))
        return
      }
      resolveExit()
    })
  })

  const outputConsumed = new Promise((resolveOutput, rejectOutput) => {
    lines.once("close", resolveOutput)
    child.stdout.once("error", rejectOutput)
  })

  await Promise.all([processExited, outputConsumed])
  return [...relevantEntries.values()]
}

export function listWindowsInstallerEntries(artifact) {
  return collectRelevantWindowsInstallerEntries("7z", ["l", "-ba", artifact])
}

function findAppBundles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const child = join(root, entry.name)
    if (!entry.isDirectory()) return []
    if (entry.name.endsWith(".app")) return [child]
    return findAppBundles(child)
  })
}

export function readMacBundleExecutable(infoPlist, runCommand = run) {
  const executable = runCommand("plutil", [
    "-extract",
    "CFBundleExecutable",
    "raw",
    "-o",
    "-",
    infoPlist,
  ]).trim()
  if (!executable) fail(`${infoPlist} has an empty CFBundleExecutable`)
  return executable
}

export function selectMacAppExecutables(
  executableNames,
  declaredExecutable,
  artifactName
) {
  const mainMatches = executableNames.filter(
    name => name === declaredExecutable
  )
  if (mainMatches.length !== 1) {
    fail(
      `${artifactName} CFBundleExecutable ${declaredExecutable} must identify exactly one app executable`
    )
  }

  const nodeMatches = executableNames.filter(name => name === "pdpp-node")
  if (nodeMatches.length !== 1) {
    fail(`${artifactName} must contain exactly one pdpp-node sidecar`)
  }
  if (declaredExecutable === "pdpp-node") {
    fail(`${artifactName} app executable must be distinct from pdpp-node`)
  }

  return {
    appExecutable: declaredExecutable,
    nodeSidecar: nodeMatches[0],
  }
}

function verifyMacApp(app, expectedArch, artifactName, verifyCodeSignature) {
  if (verifyCodeSignature) {
    run("codesign", ["--verify", "--deep", "--strict", app])
  }
  const entries = listDirectoryEntries(app)
  assertPackagedRuntime(entries, artifactName)
  assertPackagedNode(entries, artifactName, "macos")
  assertPackagedBrowser(entries, artifactName, "macos")

  const executableDirectory = join(app, "Contents", "MacOS")
  const executableNames = readdirSync(executableDirectory, {
    withFileTypes: true,
  })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
  const declaredExecutable = readMacBundleExecutable(
    join(app, "Contents", "Info.plist")
  )
  const { appExecutable, nodeSidecar } = selectMacAppExecutables(
    executableNames,
    declaredExecutable,
    artifactName
  )

  const binaries = [
    join(executableDirectory, appExecutable),
    join(executableDirectory, nodeSidecar),
    join(
      app,
      "Contents",
      "Resources",
      "personal-server",
      "dist",
      "personal-server"
    ),
    join(
      app,
      "Contents",
      "Resources",
      "personal-server",
      "dist",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node"
    ),
    join(
      app,
      "Contents",
      "Resources",
      "playwright-runner",
      "dist",
      "playwright-runner"
    ),
  ]

  for (const binary of binaries) {
    if (!existsSync(binary)) fail(`${artifactName} is missing ${binary}`)
    assertBinaryArchitecture(
      run("file", ["-b", binary]),
      expectedArch,
      basename(binary)
    )
  }
}

function verifyMacArtifacts(bundleRoot, expectedArch, verifyCodeSignature) {
  const sourceApps = findAppBundles(join(bundleRoot, "macos"))
  const dmgArtifacts = listArtifacts(join(bundleRoot, "dmg"), name =>
    name.endsWith(".dmg")
  )
  if (sourceApps.length !== 1 || dmgArtifacts.length !== 1) {
    fail("Expected exactly one macOS app and one DMG artifact")
  }
  verifyMacApp(
    sourceApps[0],
    expectedArch,
    basename(sourceApps[0]),
    verifyCodeSignature
  )

  const mountRoot = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), "dataconnect-dmg-")
  )
  let attached = false
  try {
    run("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountRoot,
      dmgArtifacts[0],
    ])
    attached = true
    const mountedApps = findAppBundles(mountRoot)
    if (mountedApps.length !== 1) {
      fail(`${basename(dmgArtifacts[0])} must contain exactly one app bundle`)
    }
    verifyMacApp(
      mountedApps[0],
      expectedArch,
      basename(dmgArtifacts[0]),
      verifyCodeSignature
    )
  } finally {
    if (attached) run("hdiutil", ["detach", mountRoot])
    rmSync(mountRoot, { recursive: true, force: true })
  }
}

function listArtifacts(directory, matcher) {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter(matcher)
    .map(filename => join(directory, filename))
}

function verifyLinuxArtifacts(bundleRoot) {
  const debArtifacts = listArtifacts(join(bundleRoot, "deb"), name =>
    name.endsWith(".deb")
  )
  const appImageArtifacts = listArtifacts(join(bundleRoot, "appimage"), name =>
    name.endsWith(".AppImage")
  )
  if (debArtifacts.length !== 1 || appImageArtifacts.length !== 1) {
    fail("Expected exactly one .deb and one .AppImage artifact")
  }
  const debEntries = listDebEntries(debArtifacts[0])
  assertPackagedRuntime(debEntries, basename(debArtifacts[0]))
  assertPackagedNode(debEntries, basename(debArtifacts[0]), "linux")
  assertPackagedBrowser(debEntries, basename(debArtifacts[0]), "linux")
  const appImageEntries = listAppImageEntries(appImageArtifacts[0])
  assertPackagedRuntime(appImageEntries, basename(appImageArtifacts[0]))
  assertPackagedNode(appImageEntries, basename(appImageArtifacts[0]), "linux")
  assertPackagedBrowser(
    appImageEntries,
    basename(appImageArtifacts[0]),
    "linux"
  )
}

async function verifyWindowsArtifacts(bundleRoot) {
  const installers = listArtifacts(join(bundleRoot, "nsis"), name =>
    name.endsWith(".exe")
  )
  if (installers.length !== 1) fail("Expected exactly one NSIS installer")
  const entries = await listWindowsInstallerEntries(installers[0])
  assertPackagedRuntime(entries, basename(installers[0]))
  assertPackagedNode(entries, basename(installers[0]), "windows")
  assertPackagedBrowser(entries, basename(installers[0]), "windows")
}

export function parseArgs(argv) {
  const args = {
    bundleRoot: "",
    expectedArch: "",
    platform: "",
    verifyCodeSignature: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--bundle-root") args.bundleRoot = argv[++index] ?? ""
    else if (token === "--expected-arch")
      args.expectedArch = argv[++index] ?? ""
    else if (token === "--platform") args.platform = argv[++index] ?? ""
    else if (token === "--verify-code-signature")
      args.verifyCodeSignature = true
    else fail(`Unknown argument: ${token}`)
  }
  if (!args.bundleRoot || !args.platform) {
    fail(
      "Usage: --bundle-root <path> --platform <macos|linux|windows> [--expected-arch <arm64|x86_64>] [--verify-code-signature]"
    )
  }
  if (
    args.platform === "macos" &&
    !["arm64", "x86_64"].includes(args.expectedArch)
  ) {
    fail("macOS verification requires --expected-arch <arm64|x86_64>")
  }
  return args
}

async function main() {
  const { bundleRoot, expectedArch, platform, verifyCodeSignature } = parseArgs(
    process.argv.slice(2)
  )
  if (platform === "macos") {
    verifyMacArtifacts(resolve(bundleRoot), expectedArch, verifyCodeSignature)
  } else if (platform === "linux") verifyLinuxArtifacts(resolve(bundleRoot))
  else if (platform === "windows")
    await verifyWindowsArtifacts(resolve(bundleRoot))
  else fail(`Unsupported platform: ${platform}`)
  console.log(
    `[verify-bundled-personal-server] ${platform} artifact contents verified`
  )
}

if (isMainModule(import.meta.url, process.argv[1])) await main()
