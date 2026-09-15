#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs"
import { basename, dirname, join, relative, resolve, sep } from "path"
import { fileURLToPath } from "url"
import {
  DEFAULT_CONNECTOR_INDEX_URL,
  DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
  fetchResolvedArtifact,
  generateLock,
  installFromLock,
  loadConnectorIndex,
  readJson,
  satisfies,
  sha256Buffer,
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
  let url
  try {
    url = new URL(artifactUrl)
  } catch {
    return null
  }
  if (url.hostname !== "github.com") return null
  if (
    url.pathname.startsWith("/PDP-Connect/data-connectors/releases/download/")
  ) {
    return PDP_CONNECT_ARTIFACT_IDENTITY
  }
  return null
}

export function ociCertificateIdentityResolver({ registry, repository }) {
  if (registry !== "ghcr.io") return null
  if (!/^pdp-connect\/connector\/[a-z0-9][a-z0-9-]*$/.test(repository))
    return null
  return DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY
}

function validateLock(lock) {
  if (!/^[12]\.\d+$/.test(lock.lockVersion)) {
    throw new Error(`Unsupported connector lockVersion: ${lock.lockVersion}`)
  }
  const ids = new Set()
  for (const entry of lock.connectors) {
    if (
      typeof entry.connectorId !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(entry.connectorId) ||
      ids.has(entry.connectorId)
    ) {
      throw new Error(`Invalid or duplicate connectorId: ${entry.connectorId}`)
    }
    ids.add(entry.connectorId)
    if (!entry.oci) continue
    if (!lock.lockVersion.startsWith("2."))
      throw new Error("OCI entries require lockVersion 2")
    if (!ociCertificateIdentityResolver(entry.oci)) {
      throw new Error(
        `Untrusted OCI registry or repository: ${entry.oci.registry}/${entry.oci.repository}`
      )
    }
    if (
      entry.artifactKind !== "pdpp-collection-profile" ||
      typeof entry.connectorKey !== "string" ||
      entry.oci.repository !== `pdp-connect/connector/${entry.connectorKey}` ||
      !/^sha256:[0-9a-f]{64}$/.test(entry.oci.digest) ||
      !/^sha256:[0-9a-f]{64}$/.test(entry.oci.configDigest)
    ) {
      throw new Error(`Invalid pinned OCI entry: ${entry.connectorId}`)
    }
  }
}

// Check the lock's recorded bytes without re-fetching either transport.
export function checkInstalledLock({ lock, dependencies, installRoot }) {
  validateLock(lock)
  if (dependencies) {
    const wanted = dependencies.connectors ?? {}
    if (
      Object.keys(wanted).length !== lock.connectors.length ||
      JSON.stringify(Object.entries(wanted).sort()) !==
        JSON.stringify(Object.entries(lock.dependencies ?? {}).sort()) ||
      lock.connectors.some(
        entry =>
          !wanted[entry.connectorId] ||
          !satisfies(entry.version, wanted[entry.connectorId])
      )
    ) {
      throw new Error(
        "Connector lock drift detected. Run `node scripts/resolve-connectors.js`."
      )
    }
  }
  const missing = [],
    mismatched = []
  for (const entry of lock.connectors) {
    const profile = entry.artifactKind === "pdpp-collection-profile"
    const files = profile
      ? [
          [entry.manifestPath, entry.manifestSha256],
          [entry.entrypointPath, entry.entrypointSha256],
          [entry.provenancePath, entry.provenanceSha256],
        ]
      : [
          [entry.sourceFiles?.metadata, entry.manifestSha256],
          [entry.sourceFiles?.script, entry.scriptSha256],
        ]
    for (const [path, digest] of files) {
      if (
        typeof path !== "string" ||
        !path ||
        path.startsWith("/") ||
        path.split("/").some(part => !part || part === "." || part === "..") ||
        /[\\\0]/.test(path) ||
        !/^sha256:[0-9a-f]{64}$/.test(digest)
      ) {
        throw new Error(`Invalid installed file contract: ${entry.connectorId}`)
      }
      const relative = profile
        ? `collection-profiles/${entry.connectorId}/${path}`
        : path
      let current = installRoot
      let absent = false
      for (const part of relative.split("/")) {
        current = join(current, part)
        try {
          if (lstatSync(current).isSymbolicLink())
            throw new Error(`Refusing installed symlink: ${relative}`)
        } catch (error) {
          if (error.code !== "ENOENT") throw error
          absent = true
          break
        }
      }
      if (absent) missing.push(relative)
      else if (sha256Buffer(readFileSync(current)) !== digest)
        mismatched.push(relative)
    }
  }
  return {
    ok: missing.length === 0 && mismatched.length === 0,
    missing,
    mismatched,
  }
}

function assertInstalled(result) {
  if (!result.ok)
    throw new Error(
      `Bundled connectors drift detected. Missing: ${result.missing.join(", ") || "(none)"} | mismatched: ${result.mismatched.join(", ") || "(none)"}`
    )
}

export function recoverInterruptedInstall(installRoot) {
  const hasInstall = existsSync(installRoot)
  const parent = dirname(installRoot)
  if (!existsSync(parent)) return
  const candidates = []
  const completed = []
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(`.${basename(installRoot)}-install-`)) continue
    const transaction = join(parent, name)
    const ownerPath = join(transaction, "owner.json")
    if (!existsSync(ownerPath)) continue
    const owner = readJson(ownerPath)
    if (owner.installRoot !== resolve(installRoot)) continue
    // Never take the recovery copy away from another running installer.
    try {
      process.kill(owner.pid, 0)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
      // A missing `next` means it was already published. Its old `previous`
      // must not compete with a later interrupted publication for recovery.
      if (!existsSync(join(transaction, "next"))) completed.push(transaction)
      else if (!hasInstall && existsSync(join(transaction, "previous")))
        candidates.push(transaction)
      continue
    }
    if (!hasInstall)
      throw new Error(
        `Connector installation is still running (pid ${owner.pid})`
      )
  }
  if (candidates.length > 1)
    throw new Error(
      `Multiple interrupted connector installs require recovery: ${candidates.join(", ")}`
    )
  if (candidates.length === 1) {
    renameSync(join(candidates[0], "previous"), installRoot)
    rmSync(candidates[0], { recursive: true, force: true })
  }
  if (existsSync(installRoot)) {
    for (const transaction of completed)
      rmSync(transaction, { recursive: true, force: true })
  }
}

// Build a complete sibling tree first. A failed download or write never touches
// the previous bundle; a failed publication rename restores it, including its lock.
export async function installConnectorsAtomically({
  lock,
  source = LOCKED_ARTIFACT_SOURCE,
  installRoot,
  install = installFromLock,
  ...options
}) {
  recoverInterruptedInstall(installRoot)
  validateLock(lock)
  const transaction = mkdtempSync(
    join(dirname(installRoot), `.${basename(installRoot)}-install-`)
  )
  const staged = join(transaction, "next")
  const previous = join(transaction, "previous")
  const hadPrevious = existsSync(installRoot)
  let moved = false
  let published = false
  try {
    writeFileSync(
      join(transaction, "owner.json"),
      JSON.stringify({ installRoot: resolve(installRoot), pid: process.pid })
    )
    // Copy only repository-owned support files, never the old connector trees.
    if (hadPrevious)
      cpSync(installRoot, staged, {
        recursive: true,
        filter: path => {
          if (path === installRoot) return true
          const top = relative(installRoot, path).split(sep)[0]
          return (
            NON_CONNECTOR_FILES.has(top) ||
            top.startsWith(".") ||
            !lstatSync(join(installRoot, top)).isDirectory()
          )
        },
      })
    else mkdirSync(staged)
    const result = await install({
      lock,
      source,
      installRoot: staged,
      layout: "source",
      artifactCertificateIdentityResolver,
      ociCertificateIdentityResolver,
      ...options,
    })
    assertInstalled(checkInstalledLock({ lock, installRoot: staged }))
    writeFileSync(
      join(staged, "lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`
    )
    if (hadPrevious) {
      renameSync(installRoot, previous)
      moved = true
    }
    try {
      renameSync(staged, installRoot)
      published = true
    } catch (error) {
      if (moved) {
        try {
          renameSync(previous, installRoot)
        } catch (restoreError) {
          throw new Error(
            `Connector publication and rollback failed; previous bundle retained at ${previous}`,
            { cause: restoreError }
          )
        }
      }
      moved = false
      throw error
    }
    return { ...result, installRoot }
  } finally {
    // Keep the recovery copy if restoring it also failed.
    if (!moved || published) {
      try {
        rmSync(transaction, { recursive: true, force: true })
      } catch (error) {
        if (!published) throw error
        console.warn(
          `[resolve-connectors] Bundle installed; could not remove recovery directory ${transaction}: ${error.message}`
        )
      }
    }
  }
}

export async function resolveOciProfiles(lock, options = {}) {
  const connectors = []
  for (const entry of lock.connectors) {
    if (entry.artifactKind !== "pdpp-collection-profile") {
      connectors.push(entry)
      continue
    }
    const connectorKey =
      entry.connectorKey ??
      { "chatgpt-pdpp": "chatgpt", "github-pdpp": "github" }[entry.connectorId]
    if (!connectorKey)
      throw new Error(`Unknown OCI connector key: ${entry.connectorId}`)
    const candidate = {
      ...entry,
      connectorKey,
      oci: entry.oci ?? {
        registry: "ghcr.io",
        repository: `pdp-connect/connector/${connectorKey}`,
      },
    }
    const artifact = await fetchResolvedArtifact(
      LOCKED_ARTIFACT_SOURCE,
      candidate,
      { allowTagResolution: true, ociCertificateIdentityResolver, ...options }
    )
    for (const [field, checksum] of [
      ["manifestSha256", "manifest"],
      ["entrypointSha256", "entrypoint"],
      ["provenanceSha256", "provenance"],
    ]) {
      if (entry[field] !== artifact.checksums[checksum])
        throw new Error(
          `OCI bytes differ from locked ${entry.connectorId}: ${field}`
        )
    }
    const { registry, repository, digest, configDigest } = artifact.oci
    candidate.oci = { registry, repository, digest, configDigest }
    for (const field of [
      "artifactUrl",
      "artifactPath",
      "artifactSha256",
      "artifactSignature",
    ])
      delete candidate[field]
    connectors.push(candidate)
  }
  return { ...lock, lockVersion: "2.0", connectors }
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

async function main() {
  const { checkMode, fromLocal, indexUrl, installLocked } = parseArgs()
  if (process.env.SKIP_CONNECTOR_FETCH) {
    console.log("[resolve-connectors] SKIP_CONNECTOR_FETCH set — skipping")
    return
  }

  recoverInterruptedInstall(CONNECTORS_DIR)
  const dependencies = readJson(DEPENDENCIES_PATH)
  const existingLock = existsSync(LOCK_PATH) ? readJson(LOCK_PATH) : null
  if (existingLock) validateLock(existingLock)
  if (checkMode && !fromLocal && !indexUrl) {
    if (!existingLock)
      throw new Error("Cannot check connectors without connectors/lock.json")
    assertInstalled(
      checkInstalledLock({
        lock: existingLock,
        dependencies,
        installRoot: CONNECTORS_DIR,
      })
    )
    console.log("[resolve-connectors] connector bundle is up to date.")
    return
  }
  if (installLocked) {
    if (!existingLock) {
      throw new Error(
        "Cannot install locked connectors without connectors/lock.json"
      )
    }
    const result = await installConnectorsAtomically({
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
  let lock = await generateLock({
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
  if (checkMode) {
    if (JSON.stringify(existingLock) !== JSON.stringify(lock)) {
      throw new Error(
        "Connector lock drift detected. Run `node scripts/resolve-connectors.js`."
      )
    }
    assertInstalled(
      await verifyInstalled({
        lock,
        source,
        installRoot: CONNECTORS_DIR,
        layout: "source",
        artifactCertificateIdentityResolver,
      })
    )
    console.log("[resolve-connectors] connector bundle is up to date.")
    return
  }
  if (!fromLocal) lock = await resolveOciProfiles(lock)
  const result = await installConnectorsAtomically({
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
