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

function validCredentialEnv(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.startsWith("PDPP_") &&
    !name.startsWith("DATACONNECT_") &&
    !name.startsWith("LD_") &&
    !name.startsWith("DYLD_") &&
    ![
      "NODE_OPTIONS",
      "NODE_PATH",
      "PATH",
      "HOME",
      "HOMEDRIVE",
      "HOMEPATH",
    ].includes(name) &&
    [...name].every(
      (character, index) =>
        character === "_" ||
        /[A-Z]/.test(character) ||
        (index > 0 && /[0-9]/.test(character))
    )
  )
}

function validateRuntimeRequirements(manifest, connectorLabel) {
  const runtimeRequirements = manifest.runtime_requirements
  if (
    runtimeRequirements !== undefined &&
    (runtimeRequirements === null ||
      typeof runtimeRequirements !== "object" ||
      Array.isArray(runtimeRequirements))
  ) {
    fail(connectorLabel, "manifest runtime requirements must be an object")
  }
  const bindings = runtimeRequirements?.bindings
  if (
    bindings !== undefined &&
    (bindings === null || typeof bindings !== "object" || Array.isArray(bindings))
  ) {
    fail(connectorLabel, "manifest runtime bindings must be an object")
  }

  const requiredBindings = Object.entries(bindings ?? {})
    .filter(([, requirement]) => {
      if (
        requirement === null ||
        typeof requirement !== "object" ||
        Array.isArray(requirement)
      ) {
        fail(connectorLabel, "manifest runtime bindings must contain objects")
      }
      return requirement.required === true
    })
    .map(([binding]) => binding)

  const unavailableBinding = requiredBindings.find(
    binding => !["network", "browser", "filesystem"].includes(binding)
  )
  if (unavailableBinding) {
    fail(connectorLabel, `requires unavailable binding: ${unavailableBinding}`)
  }

  const setup = manifest.setup
  const setupModality = setup?.modality
  if (
    setup !== undefined &&
    (setup === null || typeof setup !== "object" || Array.isArray(setup))
  ) {
    fail(connectorLabel, "manifest setup must be an object")
  }
  if (setupModality === "static_secret") {
    if (!requiredBindings.includes("network")) {
      fail(
        connectorLabel,
        "static-secret connector must require the network binding"
      )
    }
    const fields = setup.credential_capture?.fields
    if (!Array.isArray(fields) || fields.length === 0) {
      fail(connectorLabel, "static-secret setup must declare fields")
    }
    const names = new Set()
    const environments = new Set()
    for (const field of fields) {
      if (
        field === null ||
        typeof field !== "object" ||
        typeof field.name !== "string" ||
        field.name.length === 0 ||
        typeof field.required !== "boolean" ||
        typeof field.secret !== "boolean" ||
        !Array.isArray(field.env) ||
        field.env.length === 0 ||
        names.has(field.name)
      ) {
        fail(
          connectorLabel,
          "static-secret fields must have unique names and declare env"
        )
      }
      names.add(field.name)
      for (const environment of field.env) {
        if (!validCredentialEnv(environment) || environments.has(environment)) {
          fail(connectorLabel, "static-secret env names must be safe and unique")
        }
        environments.add(environment)
      }
    }
  } else if (setupModality === "manual_or_upload") {
    if (!requiredBindings.includes("filesystem")) {
      fail(
        connectorLabel,
        "manual/upload connector must require the filesystem binding"
      )
    }
    const importEnv = setup.manual_or_upload?.import_dir_env_var
    if (
      typeof importEnv !== "string" ||
      importEnv.length <= 1 ||
      !importEnv.endsWith("_DIR") ||
      !validCredentialEnv(importEnv)
    ) {
      fail(
        connectorLabel,
        "manual/upload connector must declare a safe import_dir_env_var"
      )
    }
  } else if (setupModality !== undefined) {
    fail(connectorLabel, `requires unavailable setup: ${String(setupModality)}`)
  } else if (!requiredBindings.includes("network")) {
    fail(
      connectorLabel,
      "file-based connectors without a setup modality must require the network binding"
    )
  }
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
  if (
    !/^[A-Za-z0-9_-]+$/.test(manifest.connector_key) ||
    manifest.connector_id.includes("\\") ||
    /\s|[\u0000-\u001f]/.test(manifest.connector_id)
  ) {
    fail(connectorLabel, "manifest connector key or ID is unsafe")
  }
  let connectorUri
  try {
    connectorUri = new URL(manifest.connector_id)
  } catch {
    fail(connectorLabel, "manifest connector_id must be a valid https:// URI")
  }
  if (connectorUri.protocol !== "https:" || !connectorUri.hostname) {
    fail(connectorLabel, "manifest connector_id must be a valid https:// URI")
  }
  if (manifest.version !== install.version) {
    fail(
      connectorLabel,
      `manifest version ${String(manifest.version)} does not match active version ${install.version}`
    )
  }
  if (
    install.manifestConnectorId !== undefined &&
    install.manifestConnectorId !== null &&
    install.manifestConnectorId !== manifest.connector_id
  ) {
    fail(connectorLabel, "manifest identity does not match active install")
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
  validateRuntimeRequirements(manifest, connectorLabel)
}

export function listActivePdppConnectorIds({
  activeManifestPath = join(
    homedir(),
    ".dataconnect",
    "connectors-active.json"
  ),
} = {}) {
  const active = readJson(activeManifestPath, "active connector manifest", "connectors")
  if (
    active?.connectors === null ||
    typeof active?.connectors !== "object" ||
    Array.isArray(active.connectors)
  ) {
    fail("connectors", "active connector manifest must declare connectors")
  }
  return Object.entries(active.connectors)
    .filter(([, install]) => install?.artifactKind === ARTIFACT_KIND)
    .map(([connectorId]) => connectorId)
    .sort()
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
