#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyReferenceStackRoot } from "./ensure-reference-stack.js"

export function parseArgs(argv) {
  const rootIndex = argv.indexOf("--root")
  if (rootIndex === -1 || !argv[rootIndex + 1]) {
    throw new Error(
      "Usage: node scripts/verify-reference-stack.mjs --profile <profile> --root <staged-ri-root>"
    )
  }
  const profileIndex = argv.indexOf("--profile")
  if (profileIndex === -1 || !argv[profileIndex + 1]) {
    throw new Error(
      "Usage: node scripts/verify-reference-stack.mjs --profile <profile> --root <staged-ri-root>"
    )
  }
  const profile = argv[profileIndex + 1]
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error(`Invalid profile: ${JSON.stringify(profile)}`)
  }
  const root = resolve(argv[rootIndex + 1])
  const expectedSuffix = `target/${profile}/reference-stack/ri`
  if (!root.replaceAll("\\", "/").endsWith(`/${expectedSuffix}`)) {
    throw new Error(
      `Reference stack must use the profile-scoped root src-tauri/${expectedSuffix}; got ${root}`
    )
  }
  return { profile, root }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { root } = parseArgs(process.argv.slice(2))
    const manifest = verifyReferenceStackRoot(root)
    const launcher = readFileSync(resolve(root, "launch.mjs"), "utf8")
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
    console.log(`Verified reference stack ${root}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
