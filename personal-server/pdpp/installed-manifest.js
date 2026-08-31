// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

const ACTIVE_CONNECTOR_ID = "github-pdpp"
const ARTIFACT_KIND = "pdpp-collection-profile"

function fail(label, message) {
  throw new Error(`Invalid installed PDPP ${label}: ${message}`)
}
function readJson(path, label, connectorLabel) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    fail(
      connectorLabel,
      `could not read ${label}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function requireString(value, field, connectorLabel) {
  if (typeof value !== "string" || value.length === 0)
    fail(connectorLabel, `${field} is required`)
  return value
}

function confinedFile(root, relativePath, label, connectorLabel) {
  requireString(relativePath, label, connectorLabel)
  if (isAbsolute(relativePath))
    fail(connectorLabel, `${label} must be relative`)

  const path = resolve(root, relativePath)
  const escaped =
    relative(root, path).startsWith("..") || isAbsolute(relative(root, path))
  if (escaped) fail(connectorLabel, `${label} escapes the install root`)
  if (!existsSync(path)) fail(connectorLabel, `${label} is not accessible`)
  return path
}

function verifyHash(path, expected, label, connectorLabel) {
  requireString(expected, `${label} hash`, connectorLabel)
  if (!expected.startsWith("sha256:"))
    fail(connectorLabel, `${label} hash must be sha256`)
  const actual = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`
  if (actual !== expected)
    fail(connectorLabel, `${label} hash does not match the active install`)
}

function validateManifest(
  install,
  manifest,
  connectorLabel,
  expectedConnector
) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    fail(connectorLabel, "manifest must be an object")
  }
  if (
    typeof manifest.connector_key !== "string" ||
    manifest.connector_key.length === 0 ||
    typeof manifest.connector_id !== "string" ||
    manifest.connector_id.length === 0
  ) {
    fail(connectorLabel, "manifest must declare a connector key and ID")
  }
  if (manifest.version !== install.version) {
    fail(
      connectorLabel,
      `manifest version ${String(manifest.version)} does not match active version ${install.version}`
    )
  }
  if (
    expectedConnector &&
    (manifest.connector_key !== expectedConnector.key ||
      manifest.connector_id !== expectedConnector.id)
  ) {
    fail(
      connectorLabel,
      "manifest identity does not match the selected serving profile"
    )
  }
  if (!Array.isArray(manifest.streams) || manifest.streams.length === 0) {
    fail(connectorLabel, "manifest must declare at least one stream")
  }
  const names = new Set()
  for (const stream of manifest.streams) {
    if (
      stream === null ||
      typeof stream !== "object" ||
      typeof stream.name !== "string" ||
      stream.name.length === 0
    ) {
      fail(connectorLabel, "manifest stream names must be non-empty strings")
    }
    if (!names.add(stream.name))
      fail(connectorLabel, "manifest stream names must be unique")
  }
}

/**
 * Load the manifest and provenance from the active, hash-verified install.
 * Consumers receive the artifact's values; they do not maintain a second
 * handwritten connector manifest or version constant.
 */
export function loadInstalledManifest({
  activeManifestPath = join(
    homedir(),
    ".dataconnect",
    "connectors-active.json"
  ),
  connectorId,
  connectorLabel = "connector",
  expectedConnector,
} = {}) {
  requireString(connectorId, "selected connector", connectorLabel)

  const active = readJson(
    activeManifestPath,
    "active connector manifest",
    connectorLabel
  )
  const install = active?.connectors?.[connectorId]
  if (install === null || typeof install !== "object")
    fail(connectorLabel, "active install is missing")
  if (install.artifactKind !== ARTIFACT_KIND)
    fail(connectorLabel, "active install is not a collection profile artifact")
  if (install.connectorId !== undefined && install.connectorId !== connectorId)
    fail(connectorLabel, "active install ID does not match selected connector")
  requireString(install.version, "active install version", connectorLabel)

  const root = resolve(
    requireString(install.rootPath, "active install root", connectorLabel)
  )
  const manifestPath = confinedFile(
    root,
    install.manifestPath,
    "manifest path",
    connectorLabel
  )
  const entrypointPath = confinedFile(
    root,
    install.entrypointPath,
    "entrypoint path",
    connectorLabel
  )
  const provenancePath = confinedFile(
    root,
    install.provenancePath,
    "provenance path",
    connectorLabel
  )
  verifyHash(manifestPath, install.manifestSha256, "manifest", connectorLabel)
  verifyHash(
    entrypointPath,
    install.entrypointSha256,
    "entrypoint",
    connectorLabel
  )
  verifyHash(
    provenancePath,
    install.provenanceSha256,
    "provenance",
    connectorLabel
  )

  const manifest = readJson(manifestPath, "manifest", connectorLabel)
  validateManifest(install, manifest, connectorLabel, expectedConnector)
  const provenance = readJson(provenancePath, "provenance", connectorLabel)

  return Object.freeze({
    connectorId,
    version: install.version,
    manifestDigest: install.manifestSha256,
    manifest,
    provenance,
    manifestPath,
    entrypointPath,
    provenancePath,
  })
}

/**
 * Re-read one explicit active-install path and fail closed if it no longer
 * resolves to the selection that was composed at startup. This prevents the
 * authorization and resource surfaces from cross-binding same-identity
 * artifacts from different active manifests.
 */
export function resolveSelectedInstalledManifest({
  activeManifestPath,
  connectorId,
  connectorLabel,
  expectedConnector,
  selectedInstall,
} = {}) {
  const installed = loadInstalledManifest({
    activeManifestPath,
    connectorId,
    connectorLabel,
    expectedConnector,
  })
  if (!selectedInstall) return installed
  if (
    selectedInstall.connectorId !== installed.connectorId ||
    selectedInstall.version !== installed.version ||
    selectedInstall.manifestDigest !== installed.manifestDigest ||
    selectedInstall.manifest.connector_key !== installed.manifest.connector_key ||
    selectedInstall.manifest.connector_id !== installed.manifest.connector_id
  ) {
    fail(
      connectorLabel ?? "connector",
      "active install no longer matches the composed serving selection"
    )
  }
  return selectedInstall
}

/** GitHub remains the default serving profile for existing deployments. */
export function loadInstalledGithubManifest(options = {}) {
  const connectorId = options.connectorId ?? ACTIVE_CONNECTOR_ID
  if (connectorId !== ACTIVE_CONNECTOR_ID) {
    fail("GitHub connector", `unsupported connector ${connectorId}`)
  }
  return loadInstalledManifest({
    ...options,
    connectorId,
    connectorLabel: "GitHub connector",
    expectedConnector: {
      key: "github",
      id: "https://registry.pdpp.org/connectors/github",
    },
  })
}
