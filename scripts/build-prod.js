#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production build script for DataConnect
 *
 * This script:
 * 1. Builds the playwright-runner into a standalone binary
 * 2. Builds the personal-server into a standalone binary
 * 3. Builds the platform Tauri bundle
 * 4. Finalizes personal-server runtime dependencies in that bundle
 * 5. Creates the platform distributable
 *
 * Tauri's resource glob flattens subdirectories, so we can't include
 * node_modules/ via tauri.conf.json. Instead we build the .app first,
 * copy node_modules/ in, then create the DMG ourselves.
 */

import { execSync } from "child_process"
import {
  existsSync,
  cpSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { platform, arch } from "os"
import { stageConsoleStack } from "./ensure-console-stack.js"
import { stageReferenceStack } from "./ensure-reference-stack.js"
import { nativeTauriTarget, stagePdppNode } from "./stage-pdpp-node.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const PLAYWRIGHT_RUNNER = join(ROOT, "playwright-runner")
const PERSONAL_SERVER = join(ROOT, "personal-server")
const PLAT = platform()
const TAURI_PROFILE = process.env.TAURI_PROFILE || "release"
const DRY_RUN = process.env.DATACONNECT_BUILD_PROD_DRY_RUN === "1"

function log(msg) {
  console.log(`\n🔨 ${msg}`)
}

function exec(cmd, opts = {}) {
  console.log(`   $ ${cmd}`)
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts })
}

/** Read the version from tauri.conf.json */
function getVersion() {
  const conf = JSON.parse(
    readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")
  )
  return conf.version
}

/** Copy personal-server native addons (node_modules/) into .app Resources */
function copyNativeModulesIntoApp(appPath) {
  const srcNodeModules = join(PERSONAL_SERVER, "dist", "node_modules")

  if (!existsSync(srcNodeModules)) {
    log("WARNING: personal-server dist/node_modules not found, skipping copy")
    return
  }

  const destNodeModules = join(
    appPath,
    "Contents",
    "Resources",
    "personal-server",
    "dist",
    "node_modules"
  )
  log(`  Copying native addons to ${destNodeModules}`)
  mkdirSync(dirname(destNodeModules), { recursive: true })
  cpSync(srcNodeModules, destNodeModules, { recursive: true })
}

/** Restore both non-flattened reference-stack roots after Tauri packaging. */
function copyReferenceStacksIntoApp(appPath) {
  const sourceRoot = join(
    ROOT,
    "src-tauri",
    "target",
    TAURI_PROFILE,
    "reference-stack"
  )
  const destinationRoot = join(
    appPath,
    "Contents",
    "Resources",
    "reference-stack"
  )
  const roots = ["ri", "console"]

  for (const root of roots) {
    const source = join(sourceRoot, root)
    if (!existsSync(source)) {
      throw new Error(
        `reference-stack/${root} was not staged before Tauri packaging`
      )
    }
  }

  rmSync(destinationRoot, { recursive: true, force: true })
  mkdirSync(destinationRoot, { recursive: true })
  for (const root of roots) {
    cpSync(join(sourceRoot, root), join(destinationRoot, root), {
      recursive: true,
    })
  }
}

/** Find the .app bundle in the macos bundle directory */
function findAppBundle() {
  const macosBundle = join(
    ROOT,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "macos"
  )
  if (!existsSync(macosBundle)) return null
  for (const entry of readdirSync(macosBundle)) {
    if (entry.endsWith(".app")) {
      return join(macosBundle, entry)
    }
  }
  return null
}

async function build() {
  log("Building DataConnect for production...")

  // Keep local production builds on the same fail-closed Node 22 sidecar
  // contract as the release workflow.
  const tauriTarget = nativeTauriTarget(PLAT, arch())
  const stagedNode = DRY_RUN
    ? { executable: process.execPath }
    : stagePdppNode({ ...tauriTarget, projectRoot: ROOT })

  // 1. Install playwright-runner dependencies
  log("Installing playwright-runner dependencies...")
  exec("npm install", { cwd: PLAYWRIGHT_RUNNER })

  // 2. Build playwright-runner binary
  log("Building playwright-runner binary...")
  exec("npm run build", { cwd: PLAYWRIGHT_RUNNER })

  const distDir = join(PLAYWRIGHT_RUNNER, "dist")
  if (!existsSync(distDir)) {
    throw new Error("playwright-runner build failed - dist directory not found")
  }

  // 3. Install personal-server dependencies
  log("Installing personal-server dependencies...")
  exec("npm install", { cwd: PERSONAL_SERVER })

  // 4. Install PDPP runtime dependencies that Tauri packages as resources
  log("Installing PDPP runtime dependencies...")
  exec("node scripts/ensure-pdpp-runtime.js")

  // 5. Build personal-server binary
  log("Building personal-server binary...")
  exec("npm run build", { cwd: PERSONAL_SERVER })

  const personalServerDist = join(PERSONAL_SERVER, "dist")
  if (!existsSync(personalServerDist)) {
    throw new Error("personal-server build failed - dist directory not found")
  }

  // 6. Build frontend
  log("Building frontend...")
  exec("npm run build")

  // 7. Stage both reference-stack roots before Tauri collects resources.
  log(`Staging reference implementation (${TAURI_PROFILE})...`)
  stageReferenceStack({
    nodeBinary: stagedNode.executable,
    profile: TAURI_PROFILE,
    projectRoot: ROOT,
    target: tauriTarget.target,
  })
  log(`Building and staging operator console (${TAURI_PROFILE})...`)
  stageConsoleStack({ profile: TAURI_PROFILE, projectRoot: ROOT })

  if (DRY_RUN) {
    log("Production build dry run complete; Tauri packaging was skipped.")
    return
  }

  if (PLAT === "linux") {
    log("Building Tauri AppImage...")
    exec("npx tauri build --bundles appimage")
    log("Finalizing AppImage personal-server resources...")
    exec("node scripts/finalize-linux-appimage.js")
    log("Build complete! Check src-tauri/target/release/bundle for the output.")
    return
  }

  // 7. Build the .app bundle only (no DMG).
  // Tauri's resource glob flattens directory structures, so node_modules/
  // can't be included via tauri.conf.json. We build .app first, inject
  // node_modules, then create the DMG ourselves.
  log("Building Tauri .app bundle...")
  exec("npx tauri build --bundles app")

  // 8. Inject personal-server native addons into the .app bundle.
  const appPath = findAppBundle()
  if (!appPath) {
    throw new Error(".app bundle not found after build")
  }
  log(`Injecting native addons into ${appPath}...`)
  copyNativeModulesIntoApp(appPath)
  if (PLAT === "darwin") {
    log(`Restoring reference-stack resources into ${appPath}...`)
    copyReferenceStacksIntoApp(appPath)
  }

  // 9. Create DMG from the complete .app.
  if (PLAT === "darwin") {
    const version = getVersion()
    const archName = arch() === "arm64" ? "aarch64" : "x64"
    const dmgName = `DataConnect_${version}_${archName}.dmg`
    const dmgDir = join(ROOT, "src-tauri", "target", "release", "bundle", "dmg")
    const dmgPath = join(dmgDir, dmgName)

    mkdirSync(dmgDir, { recursive: true })

    log(`Creating DMG: ${dmgName}...`)
    const stagingDir = join(dmgDir, "_staging")
    execSync(`rm -rf "${stagingDir}" "${dmgPath}"`)
    mkdirSync(stagingDir, { recursive: true })

    // Copy .app and create Applications symlink for drag-to-install
    execSync(`cp -R "${appPath}" "${stagingDir}/"`)
    execSync(`ln -s /Applications "${stagingDir}/Applications"`)

    // Create compressed DMG
    execSync(
      `hdiutil create -volname "DataConnect" -srcfolder "${stagingDir}" -ov -format UDZO "${dmgPath}"`,
      { stdio: "inherit" }
    )

    execSync(`rm -rf "${stagingDir}"`)
    log(`DMG created: ${dmgPath}`)
  }

  log("Build complete! Check src-tauri/target/release/bundle for the output.")
}

build().catch(err => {
  console.error("\n❌ Build failed:", err.message)
  process.exit(1)
})
