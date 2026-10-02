#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  referenceStackRoot,
  verifyReferenceStackRoot,
} from "./ensure-reference-stack.js"

const PROJECT_ROOT = (() => {
  const projectUrl = new URL("..", import.meta.url)
  return projectUrl.protocol === "file:"
    ? resolve(fileURLToPath(projectUrl))
    : resolve(process.cwd())
})()

export function parseArgs(argv) {
  let root
  let profile
  let refresh = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--root") {
      root = argv[++index]
      if (!root) throw new Error("--root requires a staged RI root")
    } else if (argument === "--profile") {
      profile = argv[++index]
      if (!profile) throw new Error("--profile requires a Tauri profile")
    } else if (argument === "--refresh-manifest") refresh = true
    else throw new Error(`unknown argument: ${argument}`)
  }
  if (profile && !/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error(`Invalid profile: ${JSON.stringify(profile)}`)
  }
  const resolvedRoot = root
    ? resolve(root)
    : referenceStackRoot(PROJECT_ROOT, profile)
  const profileScopedSuffix = profile
    ? `src-tauri/target/${profile}/reference-stack/ri`
    : "src-tauri/target/"
  if (
    !resolvedRoot.replaceAll("\\", "/").includes(profileScopedSuffix) ||
    !resolvedRoot.replaceAll("\\", "/").endsWith("/reference-stack/ri")
  ) {
    throw new Error(
      `Reference stack must use the profile-scoped root src-tauri/${profileScopedSuffix}; got ${resolvedRoot}`
    )
  }
  return {
    profile:
      profile ||
      resolvedRoot.replace(
        /^.*\/src-tauri\/target\/([^/]+)\/reference-stack\/ri$/,
        "$1"
      ),
    root: resolvedRoot,
    refresh,
  }
}

function walkFiles(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort(
    (left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) walkFiles(root, path, files)
    else if (entry.isFile() && relative(root, path) !== "manifest.json") {
      files.push(path)
    }
  }
  return files
}

function hashFile(path, prefixed = true) {
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex")
  return prefixed ? `sha256:${digest}` : digest
}

function manifestFiles(root, prefixed) {
  return walkFiles(root).map(path => ({
    path: relative(root, path).split("\\").join("/"),
    sha256: hashFile(path, prefixed),
    size: statSync(path).size,
  }))
}

export function refreshStackManifest(root) {
  const manifestPath = resolve(root, "manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

  if (Array.isArray(manifest.files)) {
    const prefixed = manifest.files[0]?.sha256?.startsWith("sha256:") ?? false
    const files = manifestFiles(root, prefixed)
    manifest.files = files
    if (manifest.nativeModules) {
      for (const nativeModule of Object.values(manifest.nativeModules)) {
        if (nativeModule.path) {
          nativeModule.sha256 = hashFile(
            join(root, nativeModule.path),
            prefixed
          )
        }
      }
    }
  } else if (manifest.hashes && typeof manifest.hashes === "object") {
    const files = manifestFiles(root, true)
    manifest.hashes = Object.fromEntries(
      files.map(file => [file.path, file.sha256])
    )
  } else {
    throw new Error(`${manifestPath} has no supported file hash collection`)
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export function verifyStackManifest(root) {
  const manifestPath = resolve(root, "manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

  if (Array.isArray(manifest.files)) {
    const prefixed = manifest.files[0]?.sha256?.startsWith("sha256:") ?? false
    const actual = manifestFiles(root, prefixed)
    if (JSON.stringify(manifest.files) !== JSON.stringify(actual)) {
      throw new Error(
        `${manifestPath} file hashes do not match the staged root`
      )
    }
  } else if (manifest.hashes && typeof manifest.hashes === "object") {
    const actual = manifestFiles(root, true)
    const expected = Object.fromEntries(
      actual.map(file => [file.path, file.sha256])
    )
    if (JSON.stringify(manifest.hashes) !== JSON.stringify(expected)) {
      throw new Error(
        `${manifestPath} file hashes do not match the staged root`
      )
    }
  } else {
    throw new Error(`${manifestPath} has no supported file hash collection`)
  }

  return manifest
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { root, refresh } = parseArgs(process.argv.slice(2))
    const manifest = refresh
      ? refreshStackManifest(root)
      : verifyStackManifest(root)
    if (Array.isArray(manifest.files)) verifyReferenceStackRoot(root)
    const launcher = readFileSync(resolve(root, "launch.mjs"), "utf8")
    if (Array.isArray(manifest.files)) {
      if (
        !launcher.includes("PDPP_DB_PATH") ||
        !launcher.includes("AS_PORT") ||
        !launcher.includes("RS_PORT")
      ) {
        throw new Error(
          "launch.mjs does not forward the RI database and port environment"
        )
      }
      if (manifest.embedding?.downloadAllowed !== false) {
        throw new Error("manifest does not declare offline-safe embeddings")
      }
    }
    console.log(
      `${refresh ? "Refreshed and verified" : "Verified"} reference stack ${root}`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
