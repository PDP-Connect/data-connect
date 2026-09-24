// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"

export const OWNER_PASSWORD_OWNER_SET_MARKER_FILE =
  "owner-password-owner-set.json"
export const OWNER_PASSWORD_WINDOW_REQUEST_FILE =
  "owner-password-window-request.json"
export const OWNER_PASSWORD_WINDOW_REQUEST_PREFIX =
  "owner-password-window-request-"
export const OWNER_PASSWORD_STACK_RESTART_REQUEST_FILE =
  "owner-password-stack-restart-request.json"
export const OWNER_OS_REAUTH_REQUEST_FILE = "owner-os-reauth-request.json"
export const OWNER_OS_REAUTH_REQUEST_PREFIX = "owner-os-reauth-request-"
export const OWNER_OS_REAUTH_RESULT_PREFIX = "owner-os-reauth-result-"

export interface OwnerPasswordWindowRequestState {
  requestId: number
  completedRequestId?: number
  deadlineUnixMs?: number
  status?: string
  error?: string
  grantForRequestId?: number
  grantId?: string
  grantConsumedRequestId?: number
  purpose?: "initial_setup" | "change"
}

const OWNER_REAUTH_TIMEOUT_MS = 120_000
const OWNER_REQUEST_LOCK_STALE_MS = 30_000

export function ownerPasswordOwnerSetMarkerPath(dataDir: string): string {
  return join(dataDir, OWNER_PASSWORD_OWNER_SET_MARKER_FILE)
}

function unifiedDbDir(dataDir: string): string {
  return dataDir
}

export function ownerPasswordWindowIndexPath(dataDir: string): string {
  return join(unifiedDbDir(dataDir), OWNER_PASSWORD_WINDOW_REQUEST_FILE)
}

export function ownerPasswordWindowRequestPath(
  dataDir: string,
  requestId: number
): string {
  return join(
    unifiedDbDir(dataDir),
    `${OWNER_PASSWORD_WINDOW_REQUEST_PREFIX}${requestId}.json`
  )
}

export function ownerOsReauthIndexPath(dataDir: string): string {
  return join(unifiedDbDir(dataDir), OWNER_OS_REAUTH_REQUEST_FILE)
}

export function ownerOsReauthRequestPath(
  dataDir: string,
  requestId: number
): string {
  return join(
    unifiedDbDir(dataDir),
    `${OWNER_OS_REAUTH_REQUEST_PREFIX}${requestId}.json`
  )
}

export function ownerOsReauthResultPath(
  dataDir: string,
  requestId: number
): string {
  return join(
    unifiedDbDir(dataDir),
    `${OWNER_OS_REAUTH_RESULT_PREFIX}${requestId}.json`
  )
}

function ownerRequestLockPath(dataDir: string): string {
  return join(unifiedDbDir(dataDir), ".owner-password-request.lock")
}

export async function ownerPasswordOwnerSet(dataDir: string): Promise<boolean> {
  try {
    await access(ownerPasswordOwnerSetMarkerPath(dataDir))
    return true
  } catch {
    if (process.env.PDPP_OWNER_PASSWORD_SOURCE === "desktop_generated")
      return false
    return Boolean(
      process.env.PDPP_OWNER_PASSWORD?.trim() ||
      process.env.DATACONNECT_OWNER_PASSWORD?.trim()
    )
  }
}

async function withRequestLock<T>(
  dataDir: string,
  run: () => Promise<T>
): Promise<T> {
  const lockPath = ownerRequestLockPath(dataDir)
  await mkdir(unifiedDbDir(dataDir), { recursive: true })
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath)
      try {
        return await run()
      } finally {
        await rm(lockPath, { force: true, recursive: true })
      }
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error
      const ageMs = await stat(lockPath)
        .then(entry => Date.now() - entry.mtimeMs)
        .catch(() => 0)
      if (ageMs > OWNER_REQUEST_LOCK_STALE_MS) {
        await rm(lockPath, { force: true, recursive: true })
        continue
      }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  throw new Error("Timed out waiting for owner password request lock.")
}

async function readRequestState(
  path: string
): Promise<OwnerPasswordWindowRequestState> {
  const content = await readFile(path, "utf8")
  if (!content.trim())
    throw new Error(`Owner password request state is empty: ${path}`)
  return JSON.parse(content) as OwnerPasswordWindowRequestState
}

async function readOptionalRequestState(
  path: string
): Promise<OwnerPasswordWindowRequestState> {
  try {
    return await readRequestState(path)
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { requestId: 0 }
    }
    throw error
  }
}

async function readIndexRequestState(
  path: string
): Promise<OwnerPasswordWindowRequestState> {
  try {
    return await readRequestState(path)
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { requestId: 0 }
    }
    throw error
  }
}

async function writeRequestState(
  path: string,
  state: OwnerPasswordWindowRequestState
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

async function writeRequestStateAtomically(
  path: string,
  state: OwnerPasswordWindowRequestState
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

function requestIdFromFileName(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix) || !name.endsWith(".json")) return null
  const parsed = Number.parseInt(name.slice(prefix.length, -".json".length), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

async function maxRetainedRequestId(
  dataDir: string,
  prefixes: string[]
): Promise<number> {
  const entries = await readdir(unifiedDbDir(dataDir)).catch(error => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return [] as string[]
    throw error
  })
  let max = 0
  for (const name of entries) {
    for (const prefix of prefixes) {
      const id = requestIdFromFileName(name, prefix)
      if (id !== null) max = Math.max(max, id)
    }
  }
  return max
}

function nextRequestId(
  previous: OwnerPasswordWindowRequestState,
  retainedMax = 0
): number {
  const requestId =
    Math.max(
      previous.requestId,
      previous.completedRequestId ?? 0,
      retainedMax
    ) + 1
  if (!Number.isSafeInteger(requestId))
    throw new Error(
      "Owner password request id exceeded the safe integer range."
    )
  return requestId
}

export async function requestOwnerPasswordWindow(
  dataDir: string,
  options:
    | {
        grantForRequestId?: number
        grantId?: string
        purpose?: "initial_setup" | "change"
      }
    | number = {}
): Promise<{ requestId: number }> {
  return withRequestLock(dataDir, async () => {
    const indexPath = ownerPasswordWindowIndexPath(dataDir)
    const previous = await readIndexRequestState(indexPath)
    const retainedMax = await maxRetainedRequestId(dataDir, [
      OWNER_PASSWORD_WINDOW_REQUEST_PREFIX,
    ])
    const requestId = nextRequestId(previous, retainedMax)
    const normalized =
      typeof options === "number" ? { grantForRequestId: options } : options
    const state: OwnerPasswordWindowRequestState = { requestId }
    if (typeof normalized.grantForRequestId === "number")
      state.grantForRequestId = normalized.grantForRequestId
    if (normalized.grantId) state.grantId = normalized.grantId
    state.purpose =
      normalized.purpose ?? (normalized.grantId ? "change" : "initial_setup")
    await writeRequestState(
      ownerPasswordWindowRequestPath(dataDir, requestId),
      state
    )
    await writeRequestStateAtomically(indexPath, state)
    return { requestId }
  })
}

export async function requestOwnerOsReauth(
  dataDir: string
): Promise<{ requestId: number }> {
  return withRequestLock(dataDir, async () => {
    const indexPath = ownerOsReauthIndexPath(dataDir)
    const previous = await readIndexRequestState(indexPath)
    const retainedMax = await maxRetainedRequestId(dataDir, [
      OWNER_OS_REAUTH_REQUEST_PREFIX,
      OWNER_OS_REAUTH_RESULT_PREFIX,
    ])
    const requestId = nextRequestId(previous, retainedMax)
    const state: OwnerPasswordWindowRequestState = {
      deadlineUnixMs: Date.now() + OWNER_REAUTH_TIMEOUT_MS,
      requestId,
      status: "pending",
    }
    await rm(ownerOsReauthResultPath(dataDir, requestId), { force: true })
    await writeRequestState(ownerOsReauthRequestPath(dataDir, requestId), state)
    await writeRequestStateAtomically(indexPath, state)
    return { requestId }
  })
}

export async function readOwnerOsReauthRequest(
  dataDir: string,
  requestId?: number
): Promise<OwnerPasswordWindowRequestState> {
  if (typeof requestId === "number") {
    try {
      return JSON.parse(
        await readFile(ownerOsReauthResultPath(dataDir, requestId), "utf8")
      ) as OwnerPasswordWindowRequestState
    } catch {
      return await readOptionalRequestState(
        ownerOsReauthRequestPath(dataDir, requestId)
      )
    }
  }
  return await readRequestState(ownerOsReauthIndexPath(dataDir))
}

export function ownerOsReauthSucceeded(
  state: OwnerPasswordWindowRequestState,
  requestId: number
): boolean {
  return (
    state.completedRequestId === requestId && state.status === "authenticated"
  )
}

export function ownerOsReauthAllowsReveal(
  state: OwnerPasswordWindowRequestState,
  requestId: number
): boolean {
  return (
    state.completedRequestId === requestId &&
    (state.status === "authenticated" ||
      state.status === "skipped_linux_polkit_unverified")
  )
}

export async function requestOwnerPasswordStackRestart(
  dataDir: string
): Promise<{ requestId: number }> {
  return withRequestLock(dataDir, async () => {
    const path = join(
      unifiedDbDir(dataDir),
      OWNER_PASSWORD_STACK_RESTART_REQUEST_FILE
    )
    const previous = await readIndexRequestState(path)
    const requestId = nextRequestId(previous)
    await writeRequestStateAtomically(path, { requestId })
    return { requestId }
  })
}
