// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * File-backed request/ack protocol for the autostart Tauri commands
 * (`get_autostart_enabled`/`set_autostart_enabled`,
 * `src-tauri/src/commands/desktop_settings.rs`).
 *
 * Autostart registers an OS-level login item (`.desktop` file, registry key,
 * Login Item), which only the Tauri/Rust process can perform -- this server
 * cannot reimplement that without creating a second, competing mechanism.
 * So unlike `remote-access-store.ts` and `app-config-store.ts` (both plain
 * file I/O this process owns outright), this store only REQUESTS a change by
 * writing `autostart.json` under `PDPP_DATA_DIR` (the same directory
 * `remote-access.json` lives in -- see `remote_access.rs`'s
 * `remote_access_config_path` and `desktop_settings.rs`'s
 * `autostart_state_path`, which both join the same `unified` subdirectory).
 * `src-tauri/src/unified.rs::spawn_autostart_watcher` polls this file and
 * applies the change with `tauri_plugin_autostart`, then writes back
 * `appliedRequestId`/`enabled`/`error`.
 *
 * `requestChange` polls its own write back so the owner's toggle click gets
 * a real success/failure, mirroring how the console's `enablePublicUrl`
 * awaits `configure_remote_access` synchronously today.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const AUTOSTART_STATE_FILE = "autostart.json"
const CONVERGENCE_POLL_INTERVAL_MS = 200
const CONVERGENCE_TIMEOUT_MS = 5000

export interface AutostartState {
  desiredEnabled: boolean
  requestId: number
  appliedRequestId: number
  enabled: boolean
  error: string | null
}

export interface AutostartStore {
  load: () => Promise<AutostartState>
  requestChange: (desiredEnabled: boolean) => Promise<AutostartState>
}

function resolveStatePath(dataDir: string): string {
  return join(dataDir, AUTOSTART_STATE_FILE)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createAutostartStore(dataDir: string): AutostartStore {
  const path = resolveStatePath(dataDir)

  async function readState(): Promise<AutostartState | null> {
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null
      }
      throw new Error(`Failed to read autostart state: ${(error as Error).message}`)
    }
    try {
      return JSON.parse(content) as AutostartState
    } catch (error) {
      throw new Error(`Failed to parse autostart state: ${(error as Error).message}`)
    }
  }

  async function writeState(state: AutostartState): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  }

  // Rust seeds this file on first watcher tick after startup. If it hasn't
  // started yet, `load()` throws rather than fabricating a default -- the
  // console's existing "failed" load state handles that honestly (see
  // `desktop-settings-setting.tsx`).
  async function load(): Promise<AutostartState> {
    const state = await readState()
    if (!state) {
      throw new Error(
        "Autostart state is not available yet. The DataConnect desktop app has not reported its autostart state."
      )
    }
    return state
  }

  async function requestChange(desiredEnabled: boolean): Promise<AutostartState> {
    const current = await readState()
    const nextRequestId = (current?.requestId ?? 0) + 1
    const requested: AutostartState = {
      appliedRequestId: current?.appliedRequestId ?? 0,
      desiredEnabled,
      enabled: current?.enabled ?? false,
      error: current?.error ?? null,
      requestId: nextRequestId,
    }
    await writeState(requested)

    const deadline = Date.now() + CONVERGENCE_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(CONVERGENCE_POLL_INTERVAL_MS)
      const latest = await readState()
      if (latest && latest.appliedRequestId >= nextRequestId) {
        return latest
      }
    }

    throw new Error(`Autostart change was not applied by the desktop app within ${CONVERGENCE_TIMEOUT_MS / 1000}s`)
  }

  return { load, requestChange }
}
