// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** A one-use, expiring file bridge for owner-authenticated recovery exports. */
import { randomBytes, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const POLL_INTERVAL_MS = 250
const POLL_TIMEOUT_MS = 15_000
const RESULT_TTL_MS = 120_000

interface RecoveryResult {
  commandId: string
  status: "succeeded" | "failed"
  code: string | null
  error: string | null
  createdAt: string
  expiresAt: string
  consumedAt: string | null
}

export interface RecoveryKeyStore {
  requestExport: () => Promise<string>
}

export interface RecoveryKeyStoreOptions {
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

async function writePrivate(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

async function cleanupExpired(dataDir: string): Promise<void> {
  for (const directory of ["recovery-export-commands", "recovery-export-results"]) {
    const dir = join(dataDir, directory)
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    for (const name of names.slice(0, 100)) {
      if (!name.endsWith(".json")) continue
      const path = join(dir, name)
      const value = await readJson(path).catch(() => null) as { expiresAt?: unknown } | null
      const expiresAt = typeof value?.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        if (directory === "recovery-export-results") {
          await unlink(join(dataDir, "recovery-export-commands", name)).catch(() => undefined)
        }
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      }
    }
  }
}

export function createRecoveryKeyStore(dataDir: string, options: RecoveryKeyStoreOptions = {}): RecoveryKeyStore {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS

  async function requestExport(): Promise<string> {
    await cleanupExpired(dataDir)
    const commandId = `rky_${randomBytes(16).toString("base64url")}`
    const commandPath = join(dataDir, "recovery-export-commands", `${commandId}.json`)
    const resultPath = join(dataDir, "recovery-export-results", `${commandId}.json`)
    const createdAt = new Date().toISOString()
    await writePrivate(commandPath, {
      commandId, kind: "export_database_encryption_recovery_code", createdAt,
      expiresAt: new Date(Date.now() + RESULT_TTL_MS).toISOString(),
    })

    const deadline = Date.now() + pollTimeoutMs
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
      const raw = await readJson(resultPath)
      if (!raw) continue
      const result = raw as Partial<RecoveryResult>
      if (result.commandId !== commandId ||
          (result.status !== "succeeded" && result.status !== "failed") ||
          typeof result.expiresAt !== "string") continue
      if (result.consumedAt || Date.parse(result.expiresAt) <= Date.now() ||
          !Number.isFinite(Date.parse(result.expiresAt))) {
        await unlink(commandPath).catch(() => undefined)
        await unlink(resultPath).catch(() => undefined)
        throw new Error("Recovery export result expired or was already consumed.")
      }
      if (result.status === "failed") {
        await unlink(commandPath).catch(() => undefined)
        await unlink(resultPath).catch(() => undefined)
        throw new Error(result.error || "Desktop recovery export failed.")
      }
      if (typeof result.code !== "string" || !result.code) {
        throw new Error("Recovery export request was answered without a code or an error.")
      }
      const code = result.code
      // The watcher normally removes the answered command. Remove it here too
      // if a prior watcher left it behind, before consuming the result.
      try {
        await unlink(commandPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
        await unlink(resultPath)
      } catch (error) {
        await writePrivate(resultPath, {
          ...result, code: null, consumedAt: new Date().toISOString(),
          expiresAt: new Date(0).toISOString(),
        })
        throw new Error(`Failed to consume recovery export result: ${(error as Error).message}`)
      }
      return code
    }
    await unlink(commandPath).catch(() => undefined)
    throw new Error("Timed out waiting for DataConnect to export a recovery code.")
  }

  return { requestExport }
}
