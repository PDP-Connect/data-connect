// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer-local Collection Profile sources.
 *
 * This store is deliberately separate from connector-installs. A local
 * directory is useful for development, but it has no OCI signature or
 * registry identity. The record therefore carries hashes for drift
 * detection, not authenticity, and is never returned as a verified install.
 */
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { canonicalConnectorKey } from "../connector-key.ts"

const MANIFEST_PATH = "profile/collection-profile.json"
const ENTRYPOINT_PATH = "dist/collection-profile.mjs"
const PROVENANCE_PATH = "provenance.json"
const MAX_PROFILE_BYTES = 1024 * 1024
const CONNECTOR_KEY = /^[a-z0-9][a-z0-9._-]*$/
const LOCAL_BINDINGS = new Set(["browser", "filesystem", "network"])

export interface LocalConnectorSourceRecord {
  readonly connectorId: string
  readonly connectorKey: string
  readonly displayName: string
  readonly entrypointPath: typeof ENTRYPOINT_PATH
  readonly entrypointSha256: string
  readonly manifest: Record<string, unknown>
  readonly manifestPath: typeof MANIFEST_PATH
  readonly manifestSha256: string
  readonly provenancePath?: typeof PROVENANCE_PATH
  readonly provenanceSha256?: string
  readonly root: string
  readonly selected: boolean
  readonly sourceId: string
  readonly trust: "developer-local-unsigned"
  readonly updatedAt: string
  readonly version: string
}

interface LocalSourceState {
  readonly selectedByConnectorKey: Record<string, string | null>
  readonly sources: Record<string, LocalConnectorSourceRecord>
}

export interface LocalConnectorSourceStore {
  add: (sourcePath: string) => Promise<LocalConnectorSourceRecord>
  getSelectedForConnector: (
    connectorId: string
  ) => Promise<LocalConnectorSourceRecord | null>
  list: () => Promise<readonly LocalConnectorSourceRecord[]>
  remove: (sourceId: string) => Promise<void>
  reload: (sourceId: string) => Promise<LocalConnectorSourceRecord>
  select: (connectorKey: string, sourceId: string | null) => Promise<void>
}

export type LocalConnectorSourceInspection =
  | { readonly status: "none" }
  | {
      readonly path: string
      readonly record: LocalConnectorSourceRecord
      readonly source: LocalRunSource
      readonly status: "active"
    }
  | { readonly reason: string; readonly status: "invalid" }

export interface LocalRunSource {
  readonly connector_key: string
  readonly connector_id: string
  readonly kind: "connector"
  readonly source_id: string
  readonly source_kind: "developer_local"
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`
}

function assertRecord(
  value: unknown,
  label: string
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
}

function confinedFile(
  root: string,
  relativePath: string,
  label: string
): string {
  const candidate = resolve(root, relativePath)
  if (
    relative(root, candidate).startsWith(`..${sep}`) ||
    isAbsolute(relative(root, candidate))
  ) {
    throw new Error(`${label} must stay within the local source root.`)
  }
  const resolved = realpathSync(candidate)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes the local source root.`)
  }
  if (!lstatSync(resolved).isFile()) {
    throw new Error(`${label} must resolve to a file.`)
  }
  return resolved
}

function canonicalRoot(sourcePath: string): string {
  if (!sourcePath.trim() || !isAbsolute(sourcePath)) {
    throw new Error(
      "Local connector source path must be an absolute directory path."
    )
  }
  const root = realpathSync(sourcePath)
  if (!lstatSync(root).isDirectory()) {
    throw new Error("Local connector source path must be a directory.")
  }
  return root
}

function readManifest(root: string): {
  readonly connectorId: string
  readonly connectorKey: string
  readonly displayName: string
  readonly manifest: Record<string, unknown>
  readonly version: string
} {
  const manifestPath = confinedFile(
    root,
    MANIFEST_PATH,
    "Collection Profile manifest"
  )
  if (lstatSync(manifestPath).size > MAX_PROFILE_BYTES) {
    throw new Error("Collection Profile manifest exceeds the 1 MiB limit.")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    throw new Error(
      `Collection Profile manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  assertRecord(parsed, "Collection Profile manifest")
  const connectorId = parsed.connector_id
  const connectorKey = parsed.connector_key
  const version = parsed.version
  if (
    typeof connectorId !== "string" ||
    !connectorId.startsWith("https://") ||
    typeof connectorKey !== "string" ||
    !CONNECTOR_KEY.test(connectorKey) ||
    typeof version !== "string" ||
    !version.trim()
  ) {
    throw new Error(
      "Collection Profile manifest must declare a valid connector_id, connector_key, and version."
    )
  }
  const streams = parsed.streams
  if (!Array.isArray(streams) || streams.length === 0) {
    throw new Error(
      "Collection Profile manifest must declare at least one stream."
    )
  }
  const requirements = parsed.runtime_requirements
  if (requirements !== undefined && requirements !== null) {
    assertRecord(requirements, "Collection Profile runtime_requirements")
    const bindings = requirements.bindings
    if (bindings !== undefined && bindings !== null) {
      assertRecord(bindings, "Collection Profile runtime_requirements.bindings")
      for (const [binding, requirement] of Object.entries(bindings)) {
        if (!LOCAL_BINDINGS.has(binding)) {
          throw new Error(
            `Collection Profile declares unsupported runtime binding: ${binding}`
          )
        }
        assertRecord(
          requirement,
          `Collection Profile runtime binding ${binding}`
        )
        if (
          requirement.required !== undefined &&
          typeof requirement.required !== "boolean"
        ) {
          throw new Error(
            `Collection Profile runtime binding ${binding}.required must be a boolean.`
          )
        }
      }
    }
  }
  return {
    connectorId,
    connectorKey,
    displayName:
      typeof parsed.display_name === "string" && parsed.display_name.trim()
        ? parsed.display_name.trim()
        : connectorKey,
    manifest: parsed,
    version: version.trim(),
  }
}

function sourceIdFor(root: string): string {
  return `local_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`
}

function buildRecord(
  root: string,
  selected: boolean
): LocalConnectorSourceRecord {
  const profile = readManifest(root)
  const manifestFile = confinedFile(
    root,
    MANIFEST_PATH,
    "Collection Profile manifest"
  )
  const entrypointFile = confinedFile(
    root,
    ENTRYPOINT_PATH,
    "Collection Profile entrypoint"
  )
  let provenancePath: typeof PROVENANCE_PATH | undefined
  let provenanceSha256: string | undefined
  try {
    const provenanceFile = confinedFile(
      root,
      PROVENANCE_PATH,
      "Collection Profile provenance"
    )
    provenancePath = PROVENANCE_PATH
    provenanceSha256 = sha256(provenanceFile)
  } catch (error) {
    if (existsSync(join(root, PROVENANCE_PATH))) {
      throw error
    }
  }
  return {
    connectorId: profile.connectorId,
    connectorKey: profile.connectorKey,
    displayName: profile.displayName,
    entrypointPath: ENTRYPOINT_PATH,
    entrypointSha256: sha256(entrypointFile),
    manifest: profile.manifest,
    manifestPath: MANIFEST_PATH,
    manifestSha256: sha256(manifestFile),
    ...(provenancePath && provenanceSha256 ? { provenancePath, provenanceSha256 } : {}),
    root,
    selected,
    sourceId: sourceIdFor(root),
    trust: "developer-local-unsigned",
    updatedAt: new Date().toISOString(),
    version: profile.version,
  }
}

function normalizeState(value: unknown): LocalSourceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Developer local connector source state is invalid.")
  }
  const record = value as Record<string, unknown>
  const sources = record.sources
  const selected = record.selectedByConnectorKey
  if (
    !sources ||
    typeof sources !== "object" ||
    Array.isArray(sources) ||
    !selected ||
    typeof selected !== "object" ||
    Array.isArray(selected)
  ) {
    throw new Error("Developer local connector source state is invalid.")
  }
  return {
    selectedByConnectorKey: { ...(selected as Record<string, string | null>) },
    sources: { ...(sources as Record<string, LocalConnectorSourceRecord>) },
  }
}

function emptyState(): LocalSourceState {
  return { selectedByConnectorKey: {}, sources: {} }
}

function selectedSourceId(
  state: LocalSourceState,
  connectorId: string
): string | null {
  const canonical = canonicalConnectorKey(connectorId)
  const directKey = state.selectedByConnectorKey[connectorId]
  if (directKey) {
    return directKey
  }
  if (canonical && state.selectedByConnectorKey[canonical]) {
    return state.selectedByConnectorKey[canonical]
  }
  return (
    Object.values(state.sources).find(
      source =>
        source.connectorId === connectorId &&
        state.selectedByConnectorKey[source.connectorKey] === source.sourceId
    )?.sourceId ?? null
  )
}

export function createFileLocalConnectorSourceStore(
  dataDir = process.env.PDPP_DATA_DIR || join(process.cwd(), "data")
): LocalConnectorSourceStore {
  const statePath = join(dataDir, "connector-local-sources.json")
  const read = (): LocalSourceState => {
    if (!existsSync(statePath)) {
      return emptyState()
    }
    return normalizeState(JSON.parse(readFileSync(statePath, "utf8")))
  }
  const write = (state: LocalSourceState): void => {
    mkdirSync(dataDir, { recursive: true })
    const temp = `${statePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, statePath)
  }
  const records = (
    state: LocalSourceState
  ): readonly LocalConnectorSourceRecord[] =>
    Object.values(state.sources)
      .map(record => ({
        ...record,
        selected:
          state.selectedByConnectorKey[record.connectorKey] === record.sourceId,
      }))
      .sort(
        (a, b) =>
          a.connectorKey.localeCompare(b.connectorKey) ||
          a.root.localeCompare(b.root)
      )
  return {
    async add(sourcePath) {
      const root = canonicalRoot(sourcePath.trim())
      const state = read()
      const sourceId = sourceIdFor(root)
      const existing = state.sources[sourceId]
      const record = buildRecord(
        root,
        state.selectedByConnectorKey[existing?.connectorKey ?? ""] === sourceId
      )
      write({
        selectedByConnectorKey: { ...state.selectedByConnectorKey },
        sources: { ...state.sources, [sourceId]: record },
      })
      return record
    },
    async getSelectedForConnector(connectorId) {
      const state = read()
      const sourceId = selectedSourceId(state, connectorId)
      return sourceId ? (state.sources[sourceId] ?? null) : null
    },
    async list() {
      return records(read())
    },
    async remove(sourceId) {
      const state = read()
      const record = state.sources[sourceId]
      if (!record) {
        throw new Error("Developer local connector source was not found.")
      }
      const sources = { ...state.sources }
      delete sources[sourceId]
      const selectedByConnectorKey = { ...state.selectedByConnectorKey }
      if (selectedByConnectorKey[record.connectorKey] === sourceId) {
        selectedByConnectorKey[record.connectorKey] = null
      }
      write({ selectedByConnectorKey, sources })
    },
    async reload(sourceId) {
      const state = read()
      const existing = state.sources[sourceId]
      if (!existing) {
        throw new Error("Developer local connector source was not found.")
      }
      const root = canonicalRoot(existing.root)
      const selected =
        state.selectedByConnectorKey[existing.connectorKey] === sourceId
      const record = buildRecord(root, selected)
      if (record.connectorKey !== existing.connectorKey) {
        throw new Error(
          "Reloaded Collection Profile changed connector identity."
        )
      }
      write({
        selectedByConnectorKey: { ...state.selectedByConnectorKey },
        sources: { ...state.sources, [sourceId]: record },
      })
      return record
    },
    async select(connectorKey, sourceId) {
      const state = read()
      const normalizedKey =
        canonicalConnectorKey(connectorKey) ?? connectorKey.trim()
      if (!CONNECTOR_KEY.test(normalizedKey)) {
        throw new Error("Connector key is invalid.")
      }
      if (sourceId !== null) {
        const source = state.sources[sourceId]
        if (!source || source.connectorKey !== normalizedKey) {
          throw new Error(
            "Developer local connector source does not belong to this connector."
          )
        }
      }
      write({
        selectedByConnectorKey: {
          ...state.selectedByConnectorKey,
          [normalizedKey]: sourceId,
        },
        sources: { ...state.sources },
      })
    },
  }
}

export function inspectActiveLocalConnectorSource(
  store: LocalConnectorSourceStore,
  connectorId: string
): Promise<LocalConnectorSourceInspection> {
  return store.getSelectedForConnector(connectorId).then(record => {
    if (!record) {
      return { status: "none" } as const
    }
    try {
      const root = canonicalRoot(record.root)
      const manifestFile = confinedFile(
        root,
        record.manifestPath,
        "Collection Profile manifest"
      )
      const entrypointFile = confinedFile(
        root,
        record.entrypointPath,
        "Collection Profile entrypoint"
      )
      if (
        sha256(manifestFile) !== record.manifestSha256 ||
        sha256(entrypointFile) !== record.entrypointSha256
      ) {
        return {
          reason: "Local Collection Profile changed since it was loaded.",
          status: "invalid",
        } as const
      }
      if (record.provenancePath) {
        const provenanceFile = confinedFile(
          root,
          record.provenancePath,
          "Collection Profile provenance"
        )
        if (sha256(provenanceFile) !== record.provenanceSha256) {
          return {
            reason:
              "Local Collection Profile provenance changed since it was loaded.",
            status: "invalid",
          } as const
        }
      }
      const current = readManifest(root)
      if (
        current.connectorId !== record.connectorId ||
        current.connectorKey !== record.connectorKey ||
        current.version !== record.version
      ) {
        return {
          reason:
            "Local Collection Profile identity changed since it was loaded.",
          status: "invalid",
        } as const
      }
      return {
        path: entrypointFile,
        record,
        source: {
          connector_id: record.connectorId,
          connector_key: record.connectorKey,
          kind: "connector",
          source_id: record.sourceId,
          source_kind: "developer_local",
        },
        status: "active",
      } as const
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : String(error),
        status: "invalid",
      } as const
    }
  })
}
