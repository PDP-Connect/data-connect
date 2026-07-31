#!/usr/bin/env node

/**
 * Restore the pkg personal-server binary after Tauri's Linux bundler runs
 * patchelf on resource ELF files, then rebuild the AppImage from that AppDir.
 */

import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(import.meta.dirname, "..")
const defaultAppImageDir = join(
  ROOT,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "appimage"
)
const appImageDir = resolve(process.argv[3] || defaultAppImageDir)
const sourceDist = join(ROOT, "personal-server", "dist")

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}`
    )
  }
}

export function findPersonalServerDist(root) {
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    if (
      entry.name === "dist" &&
      path.endsWith(join("personal-server", "dist"))
    ) {
      return path
    }
    const found = findPersonalServerDist(path)
    if (found) return found
  }
  return null
}

function repack(appDir, appImage) {
  const repacked = `${appImage}.repacked`
  rmSync(repacked, { force: true })

  const appImageTool = process.env.APPIMAGETOOL
  if (appImageTool || spawnSync("which", ["appimagetool"]).status === 0) {
    run(appImageTool || "appimagetool", [appDir, repacked], {
      env: { ...process.env, ARCH: "x86_64" },
    })
  } else {
    const plugin = join(
      homedir(),
      ".cache",
      "tauri",
      "linuxdeploy-plugin-appimage.AppImage"
    )
    if (!existsSync(plugin)) throw new Error("No AppImage repacker available")

    const repackDir = mkdtempSync(join(appImageDir, ".finalize-appimage-"))
    try {
      run(plugin, ["--appdir", appDir], {
        cwd: repackDir,
        env: { ...process.env, ARCH: "x86_64", APPIMAGE_EXTRACT_AND_RUN: "1" },
      })
      const generated = readdirSync(repackDir).find(entry =>
        entry.endsWith(".AppImage")
      )
      if (!generated) throw new Error("linuxdeploy did not create an AppImage")
      renameSync(join(repackDir, generated), repacked)
    } finally {
      rmSync(repackDir, { recursive: true, force: true })
    }
  }

  renameSync(repacked, appImage)
}

export function restorePersonalServer(appDir, source = sourceDist) {
  const destinationDist = findPersonalServerDist(appDir)
  if (!destinationDist)
    throw new Error(`personal-server dist not found in ${appDir}`)

  const binary = join(source, "personal-server")
  const nodeModules = join(source, "node_modules")
  if (!existsSync(binary) || !existsSync(nodeModules)) {
    throw new Error(
      "personal-server dist is incomplete; build personal-server first"
    )
  }

  cpSync(binary, join(destinationDist, "personal-server"), { force: true })
  cpSync(nodeModules, join(destinationDist, "node_modules"), {
    recursive: true,
    force: true,
  })
  return destinationDist
}

function finalize(appDir, appImage) {
  restorePersonalServer(appDir)
  repack(appDir, appImage)
  console.log(`[finalize-linux-appimage] Finalized ${basename(appImage)}`)
}

function main() {
  const appDirs = readdirSync(appImageDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith(".AppDir"))
    .map(entry => join(appImageDir, entry.name))
  const appImages = readdirSync(appImageDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".AppImage"))
    .map(entry => join(appImageDir, entry.name))

  if (appDirs.length !== 1 || appImages.length !== 1) {
    throw new Error(`Expected one AppDir and one AppImage in ${appImageDir}`)
  }

  finalize(appDirs[0], appImages[0])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
