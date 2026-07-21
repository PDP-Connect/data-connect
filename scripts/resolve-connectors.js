#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import {
  DEFAULT_CONNECTOR_INDEX_URL,
  generateLock,
  installFromLock,
  loadConnectorIndex,
  readJson,
  verifyInstalled,
} from "@opendatalabs/data-connectors-tools/installer-core"
import { isMainModule } from "./is-main-module.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const CONNECTORS_DIR = join(ROOT, "connectors")
const DEPENDENCIES_PATH = join(CONNECTORS_DIR, "connector-dependencies.json")
const LOCK_PATH = join(CONNECTORS_DIR, "lock.json")
const PDP_CONNECT_ARTIFACT_IDENTITY =
  "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-connector-release-index.yml@refs/heads/main"
const VANA_LEGACY_ARTIFACT_IDENTITY =
  "https://github.com/vana-com/data-connectors/.github/workflows/publish-connector-release-index.yml@refs/heads/main"
const VANA_LEGACY_ARTIFACT_URLS = new Set([
  "https://github.com/vana-com/data-connectors/releases/download/connectors-3f944c668395/chatgpt-playwright-2.0.0.tgz",
  "https://github.com/vana-com/data-connectors/releases/download/connectors-3f944c668395/github-playwright-1.1.4.tgz",
  "https://github.com/vana-com/data-connectors/releases/download/connectors-3f944c668395/instagram-ads-playwright-1.0.0.tgz",
  "https://github.com/vana-com/data-connectors/releases/download/connectors-3f944c668395/instagram-playwright-1.1.0.tgz",
  "https://github.com/vana-com/data-connectors/releases/download/connectors-3f944c668395/oura-playwright-1.0.1.tgz",
  "https://github.com/vana-com/data-connectors/releases/download/connectors-3f944c668395/youtube-playwright-1.0.0.tgz",
])
const NON_CONNECTOR_FILES = new Set([
  "connector-dependencies.json",
  "connector-dependencies.schema.json",
  "index.ts",
  "lock.json",
  "types",
])

export const LOCKED_ARTIFACT_SOURCE = Object.freeze({
  mode: "locked",
  doc: Object.freeze({}),
})

export function resolveIndexUrl({ checkMode, explicitIndexUrl, existingLock }) {
  if (explicitIndexUrl) return explicitIndexUrl
  if (checkMode && existingLock?.index?.mode === "remote") {
    return existingLock.index.url ?? null
  }
  return null
}

export function artifactCertificateIdentityResolver({ artifactUrl }) {
  if (VANA_LEGACY_ARTIFACT_URLS.has(artifactUrl)) {
    return VANA_LEGACY_ARTIFACT_IDENTITY
  }
  const url = new URL(artifactUrl)
  if (url.hostname !== "github.com") return null
  if (
    url.pathname.startsWith("/PDP-Connect/data-connectors/releases/download/")
  ) {
    return PDP_CONNECT_ARTIFACT_IDENTITY
  }
  return null
}

function parseArgs() {
  const out = {
    checkMode: false,
    fromLocal: process.env.CONNECTORS_PATH || null,
    indexUrl: process.env.CONNECTOR_INDEX_URL || null,
    installLocked: false,
  }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--check") {
      out.checkMode = true
      continue
    }
    if (arg === "--install-locked") {
      out.installLocked = true
      continue
    }
    if (arg === "--from-local" || arg === "--from") {
      out.fromLocal = args[i + 1] ?? null
      i += 1
      continue
    }
    if (arg === "--index-url" || arg === "--registry-url") {
      out.indexUrl = args[i + 1] ?? null
      i += 1
    }
  }
  return out
}

function removeExistingConnectorDirs() {
  for (const entry of readdirSync(CONNECTORS_DIR)) {
    if (entry.startsWith(".") || NON_CONNECTOR_FILES.has(entry)) continue
    const full = join(CONNECTORS_DIR, entry)
    if (statSync(full).isDirectory()) {
      rmSync(full, { recursive: true, force: true })
    }
  }
}

async function main() {
  const { checkMode, fromLocal, indexUrl, installLocked } = parseArgs()
  if (process.env.SKIP_CONNECTOR_FETCH) {
    console.log("[resolve-connectors] SKIP_CONNECTOR_FETCH set — skipping")
    return
  }

  const dependencies = readJson(DEPENDENCIES_PATH)
  const existingLock = existsSync(LOCK_PATH) ? readJson(LOCK_PATH) : null
  if (installLocked) {
    if (!existingLock) {
      throw new Error(
        "Cannot install locked connectors without connectors/lock.json"
      )
    }
    removeExistingConnectorDirs()
    const result = await installFromLock({
      lock: existingLock,
      source: LOCKED_ARTIFACT_SOURCE,
      artifactCertificateIdentityResolver,
      installRoot: CONNECTORS_DIR,
      layout: "source",
    })
    console.log(
      `[resolve-connectors] installed ${result.connectorCount} locked connector(s) into ${CONNECTORS_DIR}`
    )
    return
  }
  const source = await loadConnectorIndex({
    fromLocal,
    indexUrl: resolveIndexUrl({
      checkMode,
      explicitIndexUrl: indexUrl,
      existingLock,
    }),
    defaultIndexUrl: DEFAULT_CONNECTOR_INDEX_URL,
  })
  const lock = await generateLock({
    dependencies,
    source,
    artifactCertificateIdentityResolver,
    dependencyFile: "connectors/connector-dependencies.json",
    generatedAt:
      checkMode && existingLock?.generatedAt
        ? existingLock.generatedAt
        : new Date().toISOString(),
    requestedConnectorIds: Object.keys(dependencies.connectors ?? {}),
  })
  const nextLock = `${JSON.stringify(lock, null, 2)}\n`

  if (checkMode) {
    const currentLock = existsSync(LOCK_PATH)
      ? readFileSync(LOCK_PATH, "utf8")
      : null
    if (currentLock !== nextLock) {
      throw new Error(
        "Connector lock drift detected. Run `node scripts/resolve-connectors.js`."
      )
    }

    const result = await verifyInstalled({
      lock,
      source,
      artifactCertificateIdentityResolver,
      installRoot: CONNECTORS_DIR,
      layout: "source",
    })
    if (!result.ok) {
      throw new Error(
        `Bundled connectors drift detected. Missing: ${result.missing.join(", ") || "(none)"} | mismatched: ${result.mismatched.join(", ") || "(none)"}`
      )
    }

    console.log("[resolve-connectors] connector bundle is up to date.")
    return
  }

  writeFileSync(LOCK_PATH, nextLock)
  removeExistingConnectorDirs()
  const result = await installFromLock({
    lock,
    source,
    artifactCertificateIdentityResolver,
    installRoot: CONNECTORS_DIR,
    layout: "source",
  })

  console.log(
    `[resolve-connectors] installed ${result.connectorCount} connector(s) into ${CONNECTORS_DIR}`
  )
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch(error => {
    console.error(
      `[resolve-connectors] ERROR: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  })
}
