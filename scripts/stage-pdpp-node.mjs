#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { isMainModule } from "./is-main-module.js"

const SUPPORTED_TARGETS = new Map([
  ["aarch64-apple-darwin", { platform: "darwin", arch: "arm64" }],
  ["x86_64-apple-darwin", { platform: "darwin", arch: "x64" }],
  ["x86_64-unknown-linux-gnu", { platform: "linux", arch: "x64" }],
  ["x86_64-pc-windows-msvc", { platform: "win32", arch: "x64" }],
])
export const RELEASE_NODE_VERSION = "22.23.1"

export function nativeTauriTarget(platform, arch) {
  const match = [...SUPPORTED_TARGETS].find(
    ([, native]) => native.platform === platform && native.arch === arch
  )
  if (!match) fail(`Unsupported native Node.js platform: ${platform}/${arch}`)
  return {
    target: match[0],
    expectedPlatform: platform,
    expectedArch: arch,
  }
}

function fail(message) {
  throw new Error(message)
}

export function sidecarFilename(target) {
  const expected = SUPPORTED_TARGETS.get(target)
  if (!expected) fail(`Unsupported Node.js sidecar target: ${target}`)
  return `pdpp-node-${target}${expected.platform === "win32" ? ".exe" : ""}`
}

export function stagePdppNode({
  target,
  expectedPlatform,
  expectedArch,
  source = process.execPath,
  sourceLicense,
  actualPlatform = process.platform,
  actualArch = process.arch,
  nodeVersion = process.versions.node,
  projectRoot = process.cwd(),
}) {
  const supported = SUPPORTED_TARGETS.get(target)
  if (!supported) fail(`Unsupported Node.js sidecar target: ${target}`)
  if (
    expectedPlatform !== supported.platform ||
    expectedArch !== supported.arch
  ) {
    fail(
      `Target ${target} requires Node.js ${supported.platform}/${supported.arch}`
    )
  }
  if (actualPlatform !== expectedPlatform || actualArch !== expectedArch) {
    fail(
      `setup-node architecture mismatch: expected ${expectedPlatform}/${expectedArch}, got ${actualPlatform}/${actualArch}`
    )
  }
  if (nodeVersion !== RELEASE_NODE_VERSION) {
    fail(
      `Release sidecar must use Node.js ${RELEASE_NODE_VERSION}; setup-node supplied ${nodeVersion}`
    )
  }
  if (!existsSync(source) || !statSync(source).isFile()) {
    fail(`setup-node executable does not exist: ${source}`)
  }
  const license =
    sourceLicense ??
    [
      join(dirname(source), "LICENSE"),
      join(dirname(source), "..", "LICENSE"),
    ].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
  if (!license) {
    fail(
      `Node.js LICENSE was not found beside the setup-node executable: ${source}`
    )
  }

  const destination = resolve(
    projectRoot,
    "src-tauri",
    "binaries",
    sidecarFilename(target)
  )
  mkdirSync(dirname(destination), { recursive: true })
  // Debug builds may hard-link these destinations to the developer's Node.
  // Unlink first so release staging never mutates that source inode.
  rmSync(destination, { force: true })
  copyFileSync(source, destination)
  const licenseDestination = resolve(
    projectRoot,
    "src-tauri",
    "binaries",
    "pdpp-node-LICENSE"
  )
  rmSync(licenseDestination, { force: true })
  copyFileSync(license, licenseDestination)
  if (expectedPlatform !== "win32") {
    // copyFileSync preserves the executable mode on Unix; fail closed if that
    // ever changes instead of shipping a sidecar the OS cannot start.
    if ((statSync(destination).mode & 0o111) === 0) {
      fail(`Staged Node.js sidecar is not executable: ${destination}`)
    }
  }
  return { executable: destination, license: licenseDestination }
}

export function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === "--target") args.target = value
    else if (argv[index] === "--expected-platform")
      args.expectedPlatform = value
    else if (argv[index] === "--expected-arch") args.expectedArch = value
    else fail(`Unknown argument: ${argv[index]}`)
    index += 1
  }
  if (!args.target || !args.expectedPlatform || !args.expectedArch) {
    fail(
      "Usage: --target <triple> --expected-platform <platform> --expected-arch <arch>"
    )
  }
  return args
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const staged = stagePdppNode(parseArgs(process.argv.slice(2)))
  console.log(`Staged ${basename(process.execPath)} as ${staged.executable}`)
  console.log(`Staged Node.js notices as ${staged.license}`)
}
