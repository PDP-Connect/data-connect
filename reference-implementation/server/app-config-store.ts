// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * File-backed persistence for `AppConfig`, owned by the reference server.
 *
 * Reads and writes `~/.dataconnect/config.json` directly -- the SAME file
 * `src-tauri/src/commands/file_ops.rs`'s `get_app_config`/`set_app_config`
 * commands read and write (see `get_config_path` there: `home_dir().join(
 * ".dataconnect").join("config.json")`). Unlike `remote-access.json`, this
 * path is NOT under `PDPP_DATA_DIR` -- it is fixed to the user's home
 * directory regardless of where the unified data dir lives, so this store
 * resolves it the same way, independent of `dataDir`.
 *
 * This file has no OS side effect on write (plain JSON), unlike autostart
 * (see `autostart-store.ts`), so the server can read/write it directly with
 * no Rust-side involvement.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Mirrors AppConfig in src-tauri/src/commands/file_ops.rs exactly, including
// its `Default` impl (storageProvider: "local", serverMode: "cloud").
export interface AppConfig {
  storageProvider: string | null
  serverMode: string | null
  selfHostedUrl: string | null
  startMinimized: boolean
  closeToTray: boolean
}

export interface AppConfigStore {
  load: () => Promise<AppConfig>
  save: (config: AppConfig) => Promise<AppConfig>
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

function resolveConfigPath(): string {
  return join(homedir(), ".dataconnect", "config.json")
}

export function createAppConfigStore(): AppConfigStore {
  const path = resolveConfigPath()

  async function load(): Promise<AppConfig> {
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultAppConfig()
      }
      throw new Error(`Failed to read app configuration: ${(error as Error).message}`)
    }
    try {
      return JSON.parse(content) as AppConfig
    } catch (error) {
      throw new Error(`Failed to parse app configuration: ${(error as Error).message}`)
    }
  }

  async function save(config: AppConfig): Promise<AppConfig> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8")
    return config
  }

  return { load, save }
}
