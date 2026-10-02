// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Validated, revisioned owner preferences in ~/.dataconnect/config.json. */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface AppConfig {
  storageProvider: string | null
  serverMode: string | null
  selfHostedUrl: string | null
  startMinimized: boolean
  closeToTray: boolean
}

export interface AppConfigEnvelope {
  config: AppConfig
  revision: string
}

export type AppConfigPatch = {
  [K in keyof AppConfig]: { field: K; value: AppConfig[K] }
}[keyof AppConfig]

export class AppConfigConflict extends Error {
  readonly current: AppConfigEnvelope

  constructor(current: AppConfigEnvelope) {
    super("App configuration changed; reload it and try again.")
    this.current = current
  }
}

export interface AppConfigStore {
  load: () => Promise<AppConfig>
  loadEnvelope: () => Promise<AppConfigEnvelope>
  saveIfMatch: (config: AppConfig, revision: string) => Promise<AppConfigEnvelope>
  patchField: (patch: AppConfigPatch, revision: string) => Promise<AppConfigEnvelope>
}

function defaultAppConfig(): AppConfig {
  return {
    closeToTray: true,
    selfHostedUrl: null,
    serverMode: "cloud",
    startMinimized: false,
    storageProvider: "local",
  }
}

export function appConfigPath(): string {
  return join(homedir(), ".dataconnect", "config.json")
}

const FIELDS = ["storageProvider", "serverMode", "selfHostedUrl", "startMinimized", "closeToTray"] as const

export function parseAppConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid app configuration shape")
  }
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !FIELDS.includes(key as typeof FIELDS[number]))) {
    throw new Error("Invalid app configuration shape")
  }
  for (const field of ["storageProvider", "serverMode", "selfHostedUrl"] as const) {
    if (raw[field] !== null && typeof raw[field] !== "string") {
      throw new Error(`Invalid app configuration ${field}`)
    }
  }
  // Native serde defaults these two fields for older config files.
  if (raw.startMinimized !== undefined && typeof raw.startMinimized !== "boolean") {
    throw new Error("Invalid app configuration startMinimized")
  }
  if (raw.closeToTray !== undefined && typeof raw.closeToTray !== "boolean") {
    throw new Error("Invalid app configuration closeToTray")
  }
  return {
    storageProvider: raw.storageProvider as string | null,
    serverMode: raw.serverMode as string | null,
    selfHostedUrl: raw.selfHostedUrl as string | null,
    startMinimized: raw.startMinimized ?? false,
    closeToTray: raw.closeToTray ?? true,
  } as AppConfig
}

export function canonicalizeAppConfig(config: AppConfig): string {
  return JSON.stringify({
    storageProvider: config.storageProvider,
    serverMode: config.serverMode,
    selfHostedUrl: config.selfHostedUrl,
    startMinimized: config.startMinimized,
    closeToTray: config.closeToTray,
  })
}

function envelope(config: AppConfig): AppConfigEnvelope {
  return { config, revision: createHash("sha256").update(canonicalizeAppConfig(config)).digest("hex") }
}

function parsePatch(value: unknown): AppConfigPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid app configuration patch")
  }
  const patch = value as Record<string, unknown>
  if (Object.keys(patch).length !== 2 || !Object.hasOwn(patch, "field") || !Object.hasOwn(patch, "value") ||
      !FIELDS.includes(patch.field as typeof FIELDS[number])) {
    throw new Error("Invalid app configuration patch")
  }
  if (["startMinimized", "closeToTray"].includes(patch.field as string)) {
    if (typeof patch.value !== "boolean") throw new Error("Invalid app configuration patch value")
  } else if (patch.value !== null && typeof patch.value !== "string") {
    throw new Error("Invalid app configuration patch value")
  }
  return patch as unknown as AppConfigPatch
}

// A single reference-server process owns this write queue. Each mutation reads
// the current file after previous mutations finish, then compares revisions.
let writeQueue: Promise<unknown> = Promise.resolve()
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const pending = writeQueue.then(operation, operation)
  writeQueue = pending.catch(() => undefined)
  return pending
}

export function createAppConfigStore(onWrite: () => void = () => undefined): AppConfigStore {
  const path = appConfigPath()

  async function loadEnvelope(): Promise<AppConfigEnvelope> {
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return envelope(defaultAppConfig())
      throw new Error(`Failed to read app configuration: ${(error as Error).message}`)
    }
    try {
      return envelope(parseAppConfig(JSON.parse(content) as unknown))
    } catch (error) {
      throw new Error(`Failed to parse app configuration: ${(error as Error).message}`)
    }
  }

  async function write(config: AppConfig): Promise<AppConfigEnvelope> {
    const parsed = parseAppConfig(config)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx" })
    await rename(temporary, path)
    onWrite()
    return envelope(parsed)
  }

  async function saveIfMatch(config: AppConfig, revision: string): Promise<AppConfigEnvelope> {
    return serialize(async () => {
      const current = await loadEnvelope()
      if (revision !== current.revision) throw new AppConfigConflict(current)
      return write(config)
    })
  }

  async function patchField(patch: AppConfigPatch, revision: string): Promise<AppConfigEnvelope> {
    const valid = parsePatch(patch)
    return serialize(async () => {
      const current = await loadEnvelope()
      if (revision !== current.revision) throw new AppConfigConflict(current)
      return write({ ...current.config, [valid.field]: valid.value })
    })
  }

  return { load: async () => (await loadEnvelope()).config, loadEnvelope, saveIfMatch, patchField }
}
