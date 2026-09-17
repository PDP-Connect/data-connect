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

// Absent an explicit `--index-url`, stay pinned to whatever the existing lock
// already resolved against — for BOTH `--check` and a normal (re)generation.
// A bare `node scripts/resolve-connectors.js` must not silently float the 12
// legacy tarball entries to whatever the mutable "latest" release currently
// contains; an operator who wants that passes `--index-url` explicitly.
export function resolveIndexUrl({ explicitIndexUrl, existingLock }) {
  if (explicitIndexUrl) return explicitIndexUrl
  if (existingLock?.index?.mode === "remote") {
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

function reportInstalledCheck(result, { checkForInstall }) {
  if (result.ok) return true
  // A clean checkout has no ignored connector bundle yet; postinstall uses
  // this result to choose the locked install path below.
  if (
    checkForInstall &&
    result.missing.length > 0 &&
    result.mismatched.length === 0
  ) {
    console.log(
      "[resolve-connectors] connector bundle is not installed; installation required."
    )
    return false
  }
  assertInstalled(result)
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

// The Collection Profile connectors get their v2 entries AUTHORED from a
// fresh registry lookup, not migrated from the v1 tarball entry: the OCI
// artifacts are built from today's `packages/polyfill-connectors` sources,
// while the v1 tarballs were built from July pdpp pins, so the bytes
// legitimately differ. Authoring never consults the signed index — the
// registry, not the index, is the source of truth for these connectors.
export const OCI_CONNECTOR_KEYS = Object.freeze({
  "apple-health-pdpp": "apple-health",
  "chatgpt-pdpp": "chatgpt",
  "github-pdpp": "github",
  "ynab-pdpp": "ynab",
})
const OCI_DISPLAY_METADATA = Object.freeze({
  "apple-health-pdpp": Object.freeze({
    company: "apple",
    name: "Apple Health (PDPP Collection Profile)",
    description:
      "Collects Apple Health export data through the PDPP Collection Profile protocol.",
  }),
  "chatgpt-pdpp": Object.freeze({
    company: "openai",
    name: "ChatGPT (PDPP Collection Profile)",
    description:
      "Collects ChatGPT conversations, messages, memories, custom GPTs, custom instructions, and shared conversations through the PDPP Collection Profile protocol.",
  }),
  "github-pdpp": Object.freeze({
    company: "github",
    name: "GitHub (PDPP Collection Profile)",
    description:
      "Collects your GitHub profile, repositories, stars, issues, pull requests, and gists through the PDPP Collection Profile protocol.",
  }),
  "ynab-pdpp": Object.freeze({
    company: "ynab",
    name: "YNAB (PDPP Collection Profile)",
    description:
      "Collects YNAB budgets, accounts, categories, transactions, and other financial data through the PDPP Collection Profile protocol.",
  }),
})

// `company`/`name`/`description` are display metadata the collection-profile
// schema does not carry (there is no `company` or `description` field in
// `profile/collection-profile.json`), but the Rust lock deserializer requires
// them as non-optional strings (`IndexedConnectorCommon`). They are carried
// forward from the existing lock entry rather than authored from the
// registry — they label the connector, they are not part of its verified
// artifact bytes.
export async function authorOciProfile(
  connectorId,
  connectorKey,
  version,
  { company, name, description, ...options } = {}
) {
  if (!connectorKey)
    throw new Error(`Unknown OCI connector key: ${connectorId}`)
  const candidate = {
    connectorId,
    connectorKey,
    artifactKind: "pdpp-collection-profile",
    manifestPath: "profile/collection-profile.json",
    entrypointPath: "dist/collection-profile.mjs",
    provenancePath: "provenance.json",
    version,
    resolvedFrom: version,
    oci: {
      registry: "ghcr.io",
      repository: `pdp-connect/connector/${connectorKey}`,
    },
  }
  const artifact = await fetchResolvedArtifact(
    LOCKED_ARTIFACT_SOURCE,
    candidate,
    { allowTagResolution: true, ociCertificateIdentityResolver, ...options }
  )
  const { registry, repository, digest, configDigest } = artifact.oci
  return {
    ...candidate,
    version: artifact.manifest.version ?? version,
    resolvedFrom: artifact.manifest.version ?? version,
    company,
    name: name ?? artifact.manifest.display_name,
    description,
    oci: { registry, repository, digest, configDigest },
    manifestSha256: artifact.checksums.manifest,
    entrypointSha256: artifact.checksums.entrypoint,
    provenanceSha256: artifact.checksums.provenance,
  }
}

// Build a v2 lock by authoring the OCI Collection Profile entries from
// the registry and carrying every other (legacy tarball) entry through
// unchanged. This is NOT a migration: an authored entry has no prior hashes
// to preserve, so it never rejects on byte drift the way the old
// `resolveOciProfiles` migration path did. `lock.connectors` is expected to
// already exclude the OCI connectorIds (they are never requested from the
// signed index), so this only adds them. `metadata` supplies the
// non-registry display fields (see `authorOciProfile`) per connectorId.
export async function authorOciLock(
  lock,
  versions,
  metadata = {},
  options = {}
) {
  const connectors = lock.connectors.filter(
    entry => !(entry.connectorId in OCI_CONNECTOR_KEYS)
  )
  for (const connectorId of Object.keys(versions)) {
    const connectorKey = OCI_CONNECTOR_KEYS[connectorId]
    if (!connectorKey)
      throw new Error(`Unknown OCI connector key: ${connectorId}`)
    const version = versions[connectorId]
    if (!version) throw new Error(`Missing target version for ${connectorId}`)
    const metadataOverrides = Object.fromEntries(
      Object.entries(metadata[connectorId] ?? {}).filter(
        ([, value]) => value != null
      )
    )
    connectors.push(
      await authorOciProfile(connectorId, connectorKey, version, {
        ...OCI_DISPLAY_METADATA[connectorId],
        ...metadataOverrides,
        ...options,
      })
    )
  }
  connectors.sort((a, b) => a.connectorId.localeCompare(b.connectorId))
  return { ...lock, lockVersion: "2.0", connectors }
}

function parseArgs() {
  const out = {
    checkMode: false,
    checkForInstall: false,
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
    if (arg === "--check-for-install") {
      out.checkForInstall = true
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
  const { checkMode, checkForInstall, fromLocal, indexUrl, installLocked } =
    parseArgs()
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
    if (
      !reportInstalledCheck(
        checkInstalledLock({
          lock: existingLock,
          dependencies,
          installRoot: CONNECTORS_DIR,
        }),
        { checkForInstall }
      )
    ) {
      process.exitCode = 1
      return
    }
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
  // OCI-backed connectorIds are never requested from the signed index: their
  // v2 entries are authored straight from the registry, below.
  const requestedConnectorIds = Object.keys(
    dependencies.connectors ?? {}
  ).filter(connectorId => fromLocal || !(connectorId in OCI_CONNECTOR_KEYS))
  let lock = await generateLock({
    dependencies,
    source,
    artifactCertificateIdentityResolver,
    dependencyFile: "connectors/connector-dependencies.json",
    generatedAt:
      checkMode && existingLock?.generatedAt
        ? existingLock.generatedAt
        : new Date().toISOString(),
    requestedConnectorIds,
  })
  if (!fromLocal) {
    const ociVersions = {}
    const ociMetadata = {}
    for (const connectorId of Object.keys(OCI_CONNECTOR_KEYS)) {
      const requestedVersion = dependencies.connectors?.[connectorId]
      if (!requestedVersion) continue
      const existingEntry = existingLock?.connectors?.find(
        entry => entry.connectorId === connectorId
      )
      ociVersions[connectorId] = requestedVersion
      ociMetadata[connectorId] = existingEntry
        ? {
            company: existingEntry.company,
            name: existingEntry.name,
            description: existingEntry.description,
          }
        : {}
    }
    lock = await authorOciLock(lock, ociVersions, ociMetadata)
  }
  if (checkMode) {
    if (JSON.stringify(existingLock) !== JSON.stringify(lock)) {
      throw new Error(
        "Connector lock drift detected. Run `node scripts/resolve-connectors.js`."
      )
    }
    if (
      !reportInstalledCheck(
        await verifyInstalled({
          lock,
          source,
          installRoot: CONNECTORS_DIR,
          layout: "source",
          artifactCertificateIdentityResolver,
        }),
        { checkForInstall }
      )
    ) {
      process.exitCode = 1
      return
    }
    console.log("[resolve-connectors] connector bundle is up to date.")
    return
  }
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
