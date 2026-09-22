// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * File-backed persistence for `RemoteAccessConfig`, owned by the reference
 * server.
 *
 * Reads and writes `remote-access.json` under `PDPP_DATA_DIR` (the same
 * directory the Tauri desktop supervisor already grants this process for
 * `PDPP_DB_PATH` -- see `src-tauri/src/unified.rs::ri_environment`). In the
 * managed desktop stack, `PDPP_DATA_DIR` is `<app-data-dir>/unified`, which is
 * ALSO the directory `src-tauri/src/remote_access.rs::remote_access_config_path`
 * now points at, so the Rust supervisor and this server read and write the
 * exact same file -- one persisted config, not two. A plain self-hosted
 * deployment with no Tauri present gets its own file under its own
 * `PDPP_DATA_DIR` (defaulting next to the SQLite DB path) and applies a
 * changed posture the same way it applies any other reachability change:
 * restart the process.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  offRemoteAccessConfig,
  parseOriginVerification,
  type RemoteAccessConfig,
  validateRemoteAccessConfig,
} from "./remote-access-config.ts"

const REMOTE_ACCESS_CONFIG_FILE = "remote-access.json"

export interface RemoteAccessConfigStore {
  load: () => Promise<RemoteAccessConfig>
  save: (config: RemoteAccessConfig) => Promise<RemoteAccessConfig>
}

function resolveConfigPath(dataDir: string): string {
  return join(dataDir, REMOTE_ACCESS_CONFIG_FILE)
}

export function createRemoteAccessConfigStore(dataDir: string): RemoteAccessConfigStore {
  const path = resolveConfigPath(dataDir)

  async function load(): Promise<RemoteAccessConfig> {
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return offRemoteAccessConfig()
      }
      throw new Error(`Failed to read remote-access configuration: ${(error as Error).message}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      throw new Error(`Failed to parse remote-access configuration: ${(error as Error).message}`)
    }
    const validated = validateRemoteAccessConfig(parsed as RemoteAccessConfig)
    if (!validated.ok) {
      throw new Error(`Stored remote-access configuration is invalid: ${validated.message}`)
    }
    // Validation rebuilds the owner's settings and drops everything else,
    // including the supervisor's observation. Re-attach it here, on the read
    // path only, so the console can show what the supervisor saw. Only for
    // a Public URL: no other posture has a public origin to verify.
    const originVerified =
      validated.config.posture === "public_url"
        ? parseOriginVerification((parsed as { origin_verified?: unknown }).origin_verified)
        : null
    return originVerified ? { ...validated.config, origin_verified: originVerified } : validated.config
  }

  async function save(config: RemoteAccessConfig): Promise<RemoteAccessConfig> {
    // An observation is the supervisor's to write, never a request's.
    const { origin_verified: _observation, ...ownerConfig } = config
    const validated = validateRemoteAccessConfig(ownerConfig)
    if (!validated.ok) {
      throw new Error(validated.message)
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(validated.config, null, 2)}\n`, "utf8")
    return validated.config
  }

  return { load, save }
}
