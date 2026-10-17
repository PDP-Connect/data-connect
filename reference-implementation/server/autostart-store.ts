// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Owner HTTP to desktop autostart bridge. The server owns immutable commands;
 * the desktop owns observed state and one result per command. */
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const POLL_INTERVAL_MS = 200
const TIMEOUT_MS = 5000

export interface AutostartState {
  enabled: boolean
  error: string | null
  pending: boolean
}

interface ObservedState {
  enabled: boolean
  error: string | null
  observedAt: string
  revision: string
}

interface AutostartResult {
  commandId: string
  kind: "set_autostart_enabled"
  desiredEnabled: boolean
  status: "succeeded" | "failed"
  enabled: boolean
  error: string | null
}

export interface AutostartStore {
  load: () => Promise<AutostartState>
  requestChange: (desiredEnabled: boolean) => Promise<AutostartState>
}

export function autostartStatePath(dataDir: string): string {
  return join(dataDir, "autostart-state.json")
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

function parseObserved(value: unknown): ObservedState {
  if (!value || typeof value !== "object") throw new Error("Invalid observed autostart state")
  const state = value as Partial<ObservedState>
  if (typeof state.enabled !== "boolean" ||
      (state.error !== null && typeof state.error !== "string") ||
      typeof state.observedAt !== "string" || typeof state.revision !== "string") {
    throw new Error("Invalid observed autostart state")
  }
  return state as ObservedState
}

async function writeCommand(path: string, command: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(command)}\n`, { flag: "wx" })
  await rename(temporary, path)
}

export function createAutostartStore(dataDir: string, onWrite: () => void = () => undefined,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {}): AutostartStore {
  const statePath = autostartStatePath(dataDir)
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  let publishQueue: Promise<unknown> = Promise.resolve()
  let lastAcceptedAt = 0

  async function newestPendingTime(): Promise<number> {
    const directory = join(dataDir, "autostart-commands")
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    let latest = 0
    for (const name of names) {
      if (!/^ast_[A-Za-z0-9_-]{22}\.json$/.test(name)) continue
      const command = await readJson(join(directory, name)) as { createdAt?: unknown } | null
      if (typeof command?.createdAt !== "string") continue
      const createdAt = Date.parse(command.createdAt)
      if (Number.isFinite(createdAt)) latest = Math.max(latest, createdAt)
    }
    return latest
  }

  async function hasPendingCommand(): Promise<boolean> {
    const directory = join(dataDir, "autostart-commands")
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    for (const name of names) {
      if (!/^ast_[A-Za-z0-9_-]{22}\.json$/.test(name)) continue
      const command = await readJson(join(directory, name)) as { createdAt?: string } | null
      if (!command?.createdAt || Date.now() - Date.parse(command.createdAt) >= 600_000) continue
      if (!await readJson(join(dataDir, "autostart-results", name))) return true
    }
    return false
  }

  async function load(): Promise<AutostartState> {
    const raw = await readJson(statePath)
    if (!raw) {
      throw new Error("Autostart state is not available yet. The DataConnect desktop app has not reported its autostart state.")
    }
    const state = parseObserved(raw)
    return { enabled: state.enabled, error: state.error, pending: await hasPendingCommand() }
  }

  async function requestChange(desiredEnabled: boolean): Promise<AutostartState> {
    const commandId = `ast_${randomBytes(16).toString("base64url")}`
    const commandPath = join(dataDir, "autostart-commands", `${commandId}.json`)
    const resultPath = join(dataDir, "autostart-results", `${commandId}.json`)
    const published = publishQueue.then(async () => {
      if (lastAcceptedAt === 0) lastAcceptedAt = await newestPendingTime()
      lastAcceptedAt = Math.max(Date.now(), lastAcceptedAt + 1)
      await writeCommand(commandPath, {
        commandId, kind: "set_autostart_enabled", desiredEnabled,
        createdAt: new Date(lastAcceptedAt).toISOString(), status: "accepted",
      })
      onWrite()
    })
    publishQueue = published.catch(() => undefined)
    await published

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs)
      const raw = await readJson(resultPath)
      if (!raw) continue
      const result = raw as Partial<AutostartResult>
      if (result.commandId !== commandId || result.kind !== "set_autostart_enabled" ||
          result.desiredEnabled !== desiredEnabled ||
          (result.status !== "succeeded" && result.status !== "failed") ||
          typeof result.enabled !== "boolean") continue
      if (result.status === "failed" || result.enabled !== desiredEnabled || result.error) {
        throw new Error(result.error || "Desktop autostart did not reach the requested state")
      }
      // Return the observed result of this command, not a later command's state.
      return { enabled: result.enabled, error: null, pending: false }
    }
    throw new Error(`Autostart change was not applied by the desktop app within ${timeoutMs / 1000}s`)
  }

  return { load, requestChange }
}
