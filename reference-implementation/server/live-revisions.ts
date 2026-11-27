// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process revision registry behind the owner live channel
 * (`routes/owner-live.ts`). Each topic has a cheap revision function. The
 * channel carries only "topic X is now at revision R", never data; clients
 * refetch the topic through its normal owner route.
 *
 * Two sources of change:
 *   - `bump(topic)`: a store in this process wrote; emit now.
 *   - a 1 s tick, run only while a subscriber is connected, that catches
 *     writes from other processes (the Tauri watchers write `autostart.json`
 *     and `remote-access.json` directly).
 */

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { LIVE_TOPICS, type LiveTopic } from "./live-topics.ts"

export type LiveListener = (topic: LiveTopic, revision: string) => void

export interface LiveRevisions {
  register: (topic: LiveTopic, revision: () => Promise<string>) => void
  bump: (topic: LiveTopic) => void
  snapshot: () => Promise<Record<string, string>>
  subscribe: (listener: LiveListener) => () => void
}

export interface LiveRevisionsOptions {
  tickMs?: number
}

const ABSENT_REVISION = "absent"

/**
 * A content hash, not `mtime:size`: the autostart watcher rewrites its file
 * every 3 s with identical content, and an mtime revision would turn that
 * into a refetch every 3 s in every connected tab.
 */
export async function fileRevision(path: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("base64url").slice(0, 16)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ABSENT_REVISION
    }
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? "error"}`
  }
}

export function createLiveRevisions({ tickMs = 1000 }: LiveRevisionsOptions = {}): LiveRevisions {
  const sources = new Map<LiveTopic, () => Promise<string>>()
  const lastSeen = new Map<LiveTopic, string>()
  const listeners = new Set<LiveListener>()
  let timer: ReturnType<typeof setInterval> | null = null
  let subscriberEpoch = 0
  let tickingEpoch: number | null = null
  const latestRead = new Map<LiveTopic, symbol>()
  const pendingBumps = new Set<LiveTopic>()

  function beginRead(topic: LiveTopic): symbol {
    const ticket = Symbol()
    latestRead.set(topic, ticket)
    return ticket
  }

  function canCommit(topic: LiveTopic, epoch: number, ticket: symbol): boolean {
    return listeners.size > 0 && epoch === subscriberEpoch && latestRead.get(topic) === ticket
  }

  async function read(topic: LiveTopic): Promise<string | null> {
    const source = sources.get(topic)
    if (!source) return null
    try {
      return await source()
    } catch {
      return null
    }
  }

  function emit(topic: LiveTopic, revision: string): void {
    for (const listener of listeners) {
      try {
        listener(topic, revision)
      } catch {
        /* one broken subscriber must not starve the others */
      }
    }
  }

  async function tick(): Promise<void> {
    const epoch = subscriberEpoch
    if (tickingEpoch === epoch || listeners.size === 0) return
    tickingEpoch = epoch
    try {
      for (const topic of sources.keys()) {
        if (epoch !== subscriberEpoch) return
        const ticket = beginRead(topic)
        const revision = await read(topic)
        if (!canCommit(topic, epoch, ticket)) continue
        // A newer poll may supersede the read, but it still owes the writer's refetch.
        const forced = pendingBumps.delete(topic)
        const next = forced ? revision ?? ABSENT_REVISION : revision
        if (next !== null && (forced || next !== lastSeen.get(topic))) {
          lastSeen.set(topic, next)
          emit(topic, next)
        }
      }
    } finally {
      if (tickingEpoch === epoch) tickingEpoch = null
    }
  }

  // Seeds the tick's baseline only where it has none. Overwriting it would
  // hide a pending change from subscribers already attached: they would miss
  // a write that happened just before a new tab connected.
  async function snapshot(): Promise<Record<string, string>> {
    const revisions: Record<string, string> = {}
    const epoch = subscriberEpoch
    for (const topic of sources.keys()) {
      // A snapshot is observational: it must never supersede a pending bump.
      const ticket = latestRead.get(topic)
      const revision = await read(topic)
      if (revision === null) continue
      revisions[topic] = revision
      if (epoch === subscriberEpoch && latestRead.get(topic) === ticket && !lastSeen.has(topic)) {
        lastSeen.set(topic, revision)
      }
    }
    return revisions
  }

  return {
    // An explicit bump always emits, even if the content hash is unchanged:
    // the writer knows it wrote, and a refetch is cheap.
    bump(topic) {
      if (listeners.size === 0) return
      const epoch = subscriberEpoch
      const ticket = beginRead(topic)
      pendingBumps.add(topic)
      void read(topic).then(revision => {
        if (!canCommit(topic, epoch, ticket)) return
        pendingBumps.delete(topic)
        const next = revision ?? ABSENT_REVISION
        lastSeen.set(topic, next)
        emit(topic, next)
      })
    },
    register(topic, revision) {
      sources.set(topic, revision)
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (!timer) {
        timer = setInterval(() => void tick(), tickMs)
        timer.unref?.()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer) {
          clearInterval(timer)
          timer = null
          subscriberEpoch += 1
          latestRead.clear()
          pendingBumps.clear()
          lastSeen.clear()
        }
      }
    },
  }
}

export interface DefaultLiveTopicPaths {
  appConfigPath: string
  autostartPath: string
  remoteAccessPath: string
}

export function registerDefaultLiveTopics(live: LiveRevisions, paths: DefaultLiveTopicPaths): void {
  const byTopic: Record<LiveTopic, string> = {
    "desktop.app-config": paths.appConfigPath,
    "desktop.autostart": paths.autostartPath,
    "remote-access": paths.remoteAccessPath,
  }
  for (const topic of LIVE_TOPICS) {
    const path = byTopic[topic]
    live.register(topic, () => fileRevision(path))
  }
}
