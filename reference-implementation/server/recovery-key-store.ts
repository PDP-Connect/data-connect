// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RS-side half of the `recovery-export.json` file protocol
 * (`src-tauri/src/commands/recovery_key.rs`).
 *
 * Same shared-file-under-PDPP_DATA_DIR pattern `remote-access-store.ts`
 * already uses for the `user_supplied_origin` provider, applied here because
 * there is no HTTP-native way to answer this request at all: the recovery
 * code is derived from a value only the Rust process can read (the OS
 * keychain-backed database encryption key). RS bumps `requestId`; the Rust
 * watcher (`spawn_recovery_export_watcher`) notices, computes the code (or an
 * error), and writes `appliedRequestId` plus the result back to the SAME
 * file. This store polls for that convergence, then immediately overwrites
 * `code` back to `null` -- the one place this protocol differs from
 * remote-access's config file, because this file transiently holds an actual
 * secret in plaintext between the watcher's write and this read.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const RECOVERY_EXPORT_FILE = "recovery-export.json"
const POLL_INTERVAL_MS = 250
const POLL_TIMEOUT_MS = 15_000

interface RecoveryExportState {
  requestId: number
  appliedRequestId: number | null
  code: string | null
  error: string | null
}

function defaultState(): RecoveryExportState {
  return { appliedRequestId: null, code: null, error: null, requestId: 0 }
}

function resolvePath(dataDir: string): string {
  return join(dataDir, RECOVERY_EXPORT_FILE)
}

async function loadState(path: string): Promise<RecoveryExportState> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultState()
    }
    throw new Error(`Failed to read recovery export state: ${(error as Error).message}`)
  }
  if (!content.trim()) {
    return defaultState()
  }
  try {
    return JSON.parse(content) as RecoveryExportState
  } catch (error) {
    throw new Error(`Failed to parse recovery export state: ${(error as Error).message}`)
  }
}

async function saveState(path: string, state: RecoveryExportState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RecoveryKeyStore {
  /**
   * Request a fresh export, wait for the Tauri-side watcher to answer, then
   * immediately clear the plaintext code from disk before returning it. This
   * is the only entry point -- there is no plain "load" the way
   * `RemoteAccessConfigStore` has one, because there is nothing durable to
   * load: a recovery code is minted per-request, never persisted at rest.
   */
  requestExport: () => Promise<string>
}

export interface RecoveryKeyStoreOptions {
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

export function createRecoveryKeyStore(dataDir: string, options: RecoveryKeyStoreOptions = {}): RecoveryKeyStore {
  const path = resolvePath(dataDir)
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS

  async function requestExport(): Promise<string> {
    const current = await loadState(path)
    const requestId = current.requestId + 1
    await saveState(path, { appliedRequestId: current.appliedRequestId, code: null, error: null, requestId })

    const deadline = Date.now() + pollTimeoutMs
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs)
      const state = await loadState(path)
      if (state.appliedRequestId !== requestId) {
        continue
      }
      if (state.error) {
        throw new Error(state.error)
      }
      if (!state.code) {
        throw new Error("Recovery export request was answered without a code or an error.")
      }
      const code = state.code
      // Clear the plaintext code from disk now that it has been read, so it
      // does not linger after this round trip completes.
      await saveState(path, { appliedRequestId: state.appliedRequestId, code: null, error: null, requestId })
      return code
    }
    throw new Error("Timed out waiting for DataConnect to export a recovery code.")
  }

  return { requestExport }
}
