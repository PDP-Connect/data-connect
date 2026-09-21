// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * File-backed request queue for the "open this link in the system browser"
 * action (`OpenExternalLink`, `apps/console/src/app/(console)/components/
 * open-external-link.tsx`).
 *
 * Opening a URL means spawning an OS process, which only the Tauri/Rust
 * process can do -- this server cannot reimplement that without creating a
 * second, competing mechanism. Same shape as `autostart-store.ts`: this
 * store only ENQUEUES a request by appending to `open-external-url-
 * queue.json` under `PDPP_DATA_DIR` (the same directory `autostart.json`
 * and `remote-access.json` live in -- see `remote_access.rs`'s
 * `remote_access_config_path` and `src-tauri/src/commands/
 * open_external_url.rs`'s `open_external_url_queue_path`, which all join the
 * same `unified` subdirectory). `src-tauri/src/unified.rs::
 * spawn_open_external_url_watcher` polls this file, opens each pending URL
 * with `open::that_detached`, and drains the queue.
 *
 * Unlike autostart, this store does NOT poll for an ack. Autostart is a
 * toggle the owner is staring at, waiting for a definite on/off outcome, so
 * it is worth blocking the HTTP response on convergence. Opening a link is
 * fire-and-forget from the console's point of view -- the ORIGINAL bare
 * anchor / `@tauri-apps/plugin-shell` `open()` call this replaces was also
 * fire-and-forget (see `open-external-link.tsx`'s existing `.catch` on a
 * void promise) -- so enqueueing is enough; the route returns as soon as the
 * request is durably queued. A `requestId` is still recorded (for the
 * runtime test to assert on and for `queueLength`-style debugging), it is
 * just never awaited.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const OPEN_EXTERNAL_URL_QUEUE_FILE = "open-external-url-queue.json"

export interface OpenExternalUrlRequest {
  id: number
  url: string
}

interface OpenExternalUrlQueue {
  pending: OpenExternalUrlRequest[]
}

export interface OpenExternalUrlStore {
  enqueue: (url: string) => Promise<OpenExternalUrlRequest>
}

function resolveQueuePath(dataDir: string): string {
  return join(dataDir, OPEN_EXTERNAL_URL_QUEUE_FILE)
}

export function createOpenExternalUrlStore(dataDir: string): OpenExternalUrlStore {
  const path = resolveQueuePath(dataDir)

  async function readQueue(): Promise<OpenExternalUrlQueue> {
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { pending: [] }
      }
      throw new Error(`Failed to read open-external-url queue: ${(error as Error).message}`)
    }
    try {
      return JSON.parse(content) as OpenExternalUrlQueue
    } catch (error) {
      throw new Error(`Failed to parse open-external-url queue: ${(error as Error).message}`)
    }
  }

  async function writeQueue(queue: OpenExternalUrlQueue): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(queue, null, 2)}\n`, "utf8")
  }

  async function enqueue(url: string): Promise<OpenExternalUrlRequest> {
    const current = await readQueue()
    const nextId = (current.pending.at(-1)?.id ?? 0) + 1
    const request: OpenExternalUrlRequest = { id: nextId, url }
    await writeQueue({ pending: [...current.pending, request] })
    return request
  }

  return { enqueue }
}
