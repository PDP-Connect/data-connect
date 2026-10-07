"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live state for owner surfaces: one invalidation channel per visible tab,
 * TanStack Query as the cache.
 *
 * The channel (`/_ref/owner-live/:token/events`, see
 * `reference-implementation/server/routes/owner-live.ts`) says only "topic X
 * changed". On `invalidate` this tab refetches that topic through its normal
 * Server Action. Another tab or another device over a tunnel sees a change
 * within about a second, without polling.
 *
 * The channel is open only while a live surface is mounted and the document
 * is visible. A hidden tab holds no connection; on return, `hello` and
 * TanStack's refetch-on-focus bring it up to date. When the channel is down,
 * values still refresh on focus and reconnect, and `LiveStatusStrip` says the
 * page is not live (rules in `lib/live-status.ts`).
 */

import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LIVE_TOPICS, type LiveTopic } from "pdpp-reference-implementation/live-topics"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react"
import { mintLiveChannelAction } from "../lib/live-channel-actions.ts"
import {
  changedTopics,
  isSilent,
  LIVE_HELLO_TIMEOUT_MS,
  type LiveState,
  liveStatusMessage,
  reconnectDelayMs,
} from "../lib/live-status.ts"

interface LiveContextValue {
  retain: () => () => void
  retained: number
  state: LiveState
}

const LiveContext = createContext<LiveContextValue | null>(null)

const WATCHDOG_INTERVAL_MS = 5000

interface ChannelOptions {
  invalidate: (topic: string) => void
  mint: () => Promise<{ eventsPath: string }>
  onState: (state: LiveState) => void
}

function runChannel({ invalidate, mint, onState }: ChannelOptions): () => void {
  const lastSeen = new Map<string, string>()
  let state: LiveState = "connecting"
  let source: EventSource | null = null
  let generation = 0
  let attempt = 0
  let lastEventAt = 0
  let helloTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const setState = (next: LiveState) => {
    state = next
    onState(next)
  }

  const close = () => {
    generation += 1
    source?.close()
    source = null
    clearTimeout(helloTimer)
    clearTimeout(retryTimer)
  }

  const retryLater = (next: LiveState) => {
    setState(next)
    close()
    if (document.visibilityState === "visible") {
      retryTimer = setTimeout(() => void open(), reconnectDelayMs(next, attempt))
      attempt += 1
    }
  }

  const open = async () => {
    close()
    const current = generation
    let eventsPath: string
    try {
      ;({ eventsPath } = await mint())
    } catch {
      if (current === generation) retryLater("paused")
      return
    }
    if (current !== generation) return

    const events = new EventSource(eventsPath)
    source = events
    let opened = false
    events.onopen = () => {
      opened = true
    }
    // An opened response with no `hello` means a proxy is buffering the
    // stream; an unopened one is an ordinary failure.
    helloTimer = setTimeout(() => retryLater(opened ? "unsupported" : "paused"), LIVE_HELLO_TIMEOUT_MS)
    events.addEventListener("hello", event => {
      clearTimeout(helloTimer)
      attempt = 0
      lastEventAt = Date.now()
      const { revisions } = JSON.parse((event as MessageEvent<string>).data) as { revisions: Record<string, string> }
      for (const topic of changedTopics(lastSeen, revisions)) invalidate(topic)
      for (const [topic, revision] of Object.entries(revisions)) lastSeen.set(topic, revision)
      setState("live")
    })
    events.addEventListener("invalidate", event => {
      lastEventAt = Date.now()
      const { revision, topic } = JSON.parse((event as MessageEvent<string>).data) as {
        revision: string
        topic: string
      }
      lastSeen.set(topic, revision)
      invalidate(topic)
    })
    events.addEventListener("ping", () => {
      lastEventAt = Date.now()
    })
    // EventSource would retry on its own with the same, possibly expired,
    // token. Close it and mint a fresh one instead.
    events.onerror = () => retryLater("paused")
  }

  const watchdog = setInterval(() => {
    if (state === "live" && isSilent(lastEventAt, Date.now())) retryLater("paused")
  }, WATCHDOG_INTERVAL_MS)

  const onVisibility = () => {
    if (document.visibilityState !== "visible") {
      close()
      if (state === "live") setState("connecting")
      return
    }
    attempt = 0
    // Keep a known-bad state on screen while retrying; otherwise the tab
    // has just been refetched on focus, so it is connecting, not stale.
    if (state === "live") setState("connecting")
    void open()
  }

  document.addEventListener("visibilitychange", onVisibility)
  if (document.visibilityState === "visible") void open()

  return () => {
    document.removeEventListener("visibilitychange", onVisibility)
    clearInterval(watchdog)
    close()
  }
}

export function LiveProvider({
  children,
  mint = mintLiveChannelAction,
}: {
  children: ReactNode
  mint?: () => Promise<{ eventsPath: string }>
}) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 0 } } }))
  const [state, setState] = useState<LiveState>("connecting")
  const [retained, setRetained] = useState(0)
  const active = retained > 0

  const retain = useCallback(() => {
    setRetained(count => count + 1)
    return () => setRetained(count => count - 1)
  }, [])

  useEffect(() => {
    if (!active) return
    setState("connecting")
    return runChannel({
      invalidate: topic => void queryClient.invalidateQueries({ queryKey: [topic] }),
      mint,
      onState: setState,
    })
  }, [active, mint, queryClient])

  // Machine-readable state for tests and agents: `<html data-live-state>`.
  useEffect(() => {
    document.documentElement.dataset.liveState = active ? state : "idle"
  }, [active, state])

  return (
    <QueryClientProvider client={queryClient}>
      <LiveContext.Provider value={{ retain, retained, state }}>{children}</LiveContext.Provider>
    </QueryClientProvider>
  )
}

/** Read a live topic. Mounting it keeps the channel open while the tab is visible. */
export function useLiveQuery<T>(topic: LiveTopic, queryFn: () => Promise<T>) {
  const retain = useContext(LiveContext)?.retain
  useEffect(() => retain?.(), [retain])
  return useQuery({ queryFn, queryKey: [topic] })
}

/**
 * Write a live topic. The mutation stays pending until this tab's refetch
 * of the topic lands, so a control never flips back to the old value first.
 * Other tabs hear about the write from the server's bump.
 */
export function useLiveMutation<TResult, TVariables>(
  topic: LiveTopic,
  mutationFn: (variables: TVariables) => Promise<TResult>
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: [topic] }),
  })
}

export function useLiveStatus(): LiveState {
  return useContext(LiveContext)?.state ?? "connecting"
}

function formatReadAt(updatedAt: number): string {
  return new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

const LIVE_TOPIC_SET: ReadonlySet<unknown> = new Set(LIVE_TOPICS)

/** Oldest successful read among mounted live queries, or 0 if none. */
function useOldestLiveRead(): number {
  const cache = useQueryClient().getQueryCache()
  const read = () =>
    cache
      .findAll({ predicate: query => LIVE_TOPIC_SET.has(query.queryKey[0]) && query.getObserversCount() > 0 })
      .map(query => query.state.dataUpdatedAt)
      .filter(updatedAt => updatedAt > 0)
      .reduce((oldest, updatedAt) => (oldest === 0 ? updatedAt : Math.min(oldest, updatedAt)), 0)
  return useSyncExternalStore(cache.subscribe.bind(cache), read, () => 0)
}

/** Console-wide notice, shown only while a live surface is mounted and the channel is not live. */
export function LiveStatusStrip() {
  const context = useContext(LiveContext)
  if (!context || context.retained === 0) return null
  return <LiveStatusNotice state={context.state} />
}

function LiveStatusNotice({ state }: { state: LiveState }) {
  const oldestRead = useOldestLiveRead()
  const message = liveStatusMessage(state, oldestRead > 0 ? formatReadAt(oldestRead) : null)
  if (!message) return null
  return (
    <p
      className="pdpp-caption mb-6 rounded-md border border-amber-500/30 bg-amber-500/8 px-4 py-2.5 text-amber-700 dark:text-amber-400"
      data-live-state={state}
      data-testid="live-status-strip"
      role="status"
    >
      {message}
    </p>
  )
}

/** "Read at 10:42" next to a live surface's values, shown only while the channel is not live. */
export function LiveReadAt({ updatedAt }: { updatedAt: number }) {
  const state = useLiveStatus()
  if (state === "live" || state === "connecting" || updatedAt === 0) return null
  return (
    <span className="pdpp-caption text-muted-foreground" data-testid="live-read-at">
      Read at {formatReadAt(updatedAt)}
    </span>
  )
}
