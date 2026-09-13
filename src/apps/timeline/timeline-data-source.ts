// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  LocalTimelineCapability,
  LocalTimelineConsentRequest,
} from "@/services/pdppTimeline"

export const TIMELINE_MAX_RECORDS = 100
export const TIMELINE_MAX_STREAMS = 24

export type TimelineField = {
  name: string
  type?: string | readonly string[]
  format?: string
}

export type TimelineStream = {
  id: string
  label: string
  fields: readonly TimelineField[]
  primaryKey: readonly string[]
  timestampFields: readonly string[]
  recordCount?: number
}

export type TimelineRecord = {
  id: string
  data: Readonly<Record<string, unknown>>
}

export type TimelineStreamRead = {
  stream: TimelineStream
  records: readonly TimelineRecord[]
  hasMore: boolean
  cursor?: string | null
}

export type TimelineRead = {
  streams: readonly TimelineStreamRead[]
}

export type TimelineReadOptions = {
  maxStreams: number
  maxRecords: number
  signal: AbortSignal
}

export type TimelineReadResult =
  | { kind: "ready"; read: TimelineRead }
  | { kind: "unauthorized" }
  | { kind: "revoked" }
  | {
      kind: "error"
      code: "unavailable" | "failed"
      message: string
      retryable: boolean
    }

/** A bounded PDPP read result keeps rendering independent of transport details. */
export interface TimelineDataSource {
  read(options: TimelineReadOptions): Promise<TimelineReadResult>
  loadMore?(
    read: TimelineRead,
    options: TimelineReadOptions
  ): Promise<TimelineReadResult>
  requestConsent?(): Promise<LocalTimelineConsentRequest>
  approveConsent?(consent: LocalTimelineConsentRequest): Promise<void>
  revokeConsent?(): Promise<boolean>
}

type PdppStreamList = {
  data: Array<{
    name: string
    record_count?: number
    fields?: readonly TimelineField[]
    primary_key?: readonly string[]
    timestamp_fields?: readonly string[]
  }>
}

type PdppRecordList = {
  data: Array<{ id: string; data: Record<string, unknown> }>
  has_more: boolean
  next_cursor?: string
}

export function createProductionTimelineDataSource({
  port,
  devToken,
}: {
  port: number | null
  devToken: string | null
}): TimelineDataSource {
  return {
    async requestConsent() {
      if (!port || !devToken) {
        throw new Error(
          "Personal Server is still starting. Try again in a moment."
        )
      }
      const { createLocalTimelineConsentRequest } =
        await import("@/services/pdppTimeline")
      return createLocalTimelineConsentRequest(port, devToken)
    },
    async approveConsent(consent) {
      if (!port || !devToken) {
        throw new Error(
          "Personal Server is still starting. Try again in a moment."
        )
      }
      const { approveLocalTimelineConsent } =
        await import("@/services/pdppTimeline")
      await approveLocalTimelineConsent(port, devToken, consent)
    },
    async revokeConsent() {
      if (!port || !devToken) return false
      const { revokeLocalTimelineConsent } =
        await import("@/services/pdppTimeline")
      return revokeLocalTimelineConsent(port, devToken)
    },
    async read({ maxStreams, maxRecords, signal }) {
      if (!port || !devToken) {
        return {
          kind: "error",
          code: "unavailable",
          message: "Timeline is waiting for your local Personal Server.",
          retryable: true,
        }
      }
      const {
        clearLocalTimelineCapability,
        getLocalTimelineCapability,
        PdppTimelineRequestError,
        readLocalTimeline,
      } = await import("@/services/pdppTimeline")
      const capability = getLocalTimelineCapability()
      if (!capability) return { kind: "unauthorized" }
      try {
        const streams = await readLocalTimeline<PdppStreamList>(
          port,
          "/v1/streams",
          capability,
          signal
        )
        const selected = streams.data.slice(0, maxStreams)
        const reads = await readAllTimelinePages({
          port,
          streams: selected,
          capability,
          maxRecords,
          signal,
          read: readLocalTimeline,
        })
        return { kind: "ready", read: { streams: reads } }
      } catch (error) {
        if (error instanceof PdppTimelineRequestError) {
          if (
            error.code === "grant_revoked" ||
            error.code === "grant_expired"
          ) {
            clearLocalTimelineCapability()
            return { kind: "unauthorized" }
          }
          if (error.status === 401) return { kind: "unauthorized" }
        }
        return {
          kind: "error",
          code: "failed",
          message: "Timeline records could not be loaded.",
          retryable: true,
        }
      }
    },
    async loadMore(read, { maxRecords, signal }) {
      if (!port || !devToken) {
        return {
          kind: "error",
          code: "unavailable",
          message: "Timeline is waiting for your local Personal Server.",
          retryable: true,
        }
      }
      const {
        clearLocalTimelineCapability,
        getLocalTimelineCapability,
        PdppTimelineRequestError,
        readLocalTimeline,
      } = await import("@/services/pdppTimeline")
      const capability = getLocalTimelineCapability()
      if (!capability) return { kind: "unauthorized" }
      try {
        const streams = await readNextTimelinePages({
          port,
          streams: read.streams,
          capability,
          maxRecords,
          signal,
          read: readLocalTimeline,
        })
        return { kind: "ready", read: { streams } }
      } catch (error) {
        if (error instanceof PdppTimelineRequestError) {
          if (
            error.code === "grant_revoked" ||
            error.code === "grant_expired"
          ) {
            clearLocalTimelineCapability()
            return { kind: "unauthorized" }
          }
          if (error.status === 401) return { kind: "unauthorized" }
        }
        return {
          kind: "error",
          code: "failed",
          message: "Timeline records could not be loaded.",
          retryable: true,
        }
      }
    },
  }
}

async function readAllTimelinePages({
  port,
  streams,
  capability,
  maxRecords,
  signal,
  read,
}: {
  port: number
  streams: PdppStreamList["data"]
  capability: LocalTimelineCapability
  maxRecords: number
  signal: AbortSignal
  read: <T>(
    port: number,
    path: string,
    capability: LocalTimelineCapability,
    signal: AbortSignal
  ) => Promise<T>
}): Promise<TimelineRead["streams"]> {
  const pending = streams.map(stream => ({
    stream,
    cursor: null as string | null,
    records: [] as TimelineRecord[],
    seenIds: new Set<string>(),
    hasMore: true,
  }))
  let remaining = Math.max(0, maxRecords)

  while (remaining > 0) {
    const ready = pending.filter(entry => entry.hasMore)
    if (!ready.length) break
    // Fetching from more streams than the budget can absorb would force us to
    // discard part of a page. Read from only as many streams as we can seat, so
    // every fetched record is admitted and every cursor we keep is honest. The
    // streams we skip stay untouched at `cursor: null`, meaning unread rather
    // than exhausted, and `loadMore` replays them from the beginning.
    const active = ready.slice(0, Math.min(ready.length, remaining))
    const pageLimit = Math.max(
      1,
      Math.min(100, Math.floor(remaining / active.length))
    )
    const pages = await Promise.all(
      active.map(async entry => ({
        entry,
        page: await read<PdppRecordList>(
          port,
          `/v1/streams/${encodeURIComponent(entry.stream.name)}/records?limit=${pageLimit}${entry.cursor ? `&cursor=${encodeURIComponent(entry.cursor)}` : ""}`,
          capability,
          signal
        ),
      }))
    )
    let added = 0
    let advanced = false
    for (const { entry, page } of pages) {
      let consumedWholePage = true
      for (const record of page.data) {
        if (added >= remaining) {
          // The global budget stopped this page short. Leave the cursor where
          // it was so the unread remainder stays reachable, and never let
          // budget exhaustion be recorded as source exhaustion.
          consumedWholePage = false
          break
        }
        if (entry.seenIds.has(record.id)) continue
        entry.seenIds.add(record.id)
        entry.records.push(record)
        added += 1
      }
      if (!consumedWholePage) {
        entry.hasMore = true
        continue
      }
      const nextCursor =
        typeof page.next_cursor === "string" ? page.next_cursor : null
      if (page.has_more !== entry.hasMore || nextCursor !== entry.cursor) {
        advanced = true
      }
      entry.hasMore = page.has_more
      entry.cursor = nextCursor
    }
    // Progress is either new records or a moved cursor; without either, a
    // source that keeps returning nothing would loop forever.
    if (added === 0 && !advanced) break
    remaining -= added
  }

  return pending.map(entry => {
    const fields = normalizeTimelineFields(entry.stream.fields, entry.records)
    return {
      stream: {
        id: entry.stream.name,
        label: humanizeStreamName(entry.stream.name),
        fields,
        primaryKey: entry.stream.primary_key ?? [],
        timestampFields: entry.stream.timestamp_fields ?? [],
        recordCount: entry.stream.record_count,
      },
      records: entry.records,
      hasMore: entry.hasMore,
      cursor: entry.cursor,
    }
  })
}

function normalizeTimelineFields(
  manifestFields: readonly TimelineField[] | undefined,
  records: readonly TimelineRecord[]
) {
  if (manifestFields?.length) return manifestFields
  const fieldNames = new Set<string>()
  for (const record of records) {
    Object.keys(record.data).forEach(field => fieldNames.add(field))
  }
  return Array.from(fieldNames, name => ({ name }))
}

async function readNextTimelinePages({
  port,
  streams,
  capability,
  maxRecords,
  signal,
  read,
}: {
  port: number
  streams: readonly TimelineStreamRead[]
  capability: LocalTimelineCapability
  maxRecords: number
  signal: AbortSignal
  read: <T>(
    port: number,
    path: string,
    capability: LocalTimelineCapability,
    signal: AbortSignal
  ) => Promise<T>
}): Promise<TimelineRead["streams"]> {
  const pending = streams.map(streamRead => ({
    streamRead,
    cursor: streamRead.cursor ?? null,
    records: [...streamRead.records],
    seenIds: new Set(streamRead.records.map(record => record.id)),
    hasMore: streamRead.hasMore,
  }))
  let remaining = Math.max(0, maxRecords)

  while (remaining > 0) {
    // A stream with more records but no cursor was never consumed past its
    // start, so replaying it from the beginning is what makes it reachable.
    // Records already held are filtered by `seenIds` below.
    const active = pending.filter(entry => entry.hasMore)
    if (!active.length) break
    const pageLimit = Math.max(
      1,
      Math.min(100, Math.floor(remaining / active.length))
    )
    const pages = await Promise.all(
      active.map(async entry => ({
        entry,
        page: await read<PdppRecordList>(
          port,
          `/v1/streams/${encodeURIComponent(entry.streamRead.stream.id)}/records?limit=${pageLimit}${entry.cursor ? `&cursor=${encodeURIComponent(entry.cursor)}` : ""}`,
          capability,
          signal
        ),
      }))
    )
    let accepted = 0
    let advanced = false
    for (const { entry, page } of pages) {
      let consumedWholePage = true
      for (const record of page.data) {
        if (accepted >= remaining) {
          // The global budget stopped this page short. Keep the cursor that
          // still returns this record so the next read can pick it up.
          consumedWholePage = false
          break
        }
        if (entry.seenIds.has(record.id)) continue
        entry.seenIds.add(record.id)
        entry.records.push(record)
        accepted += 1
      }
      if (!consumedWholePage) continue
      // The whole page was admitted or knowingly skipped as duplicate, so its
      // cursor is safe to commit. A source that reports more records without a
      // cursor stays `hasMore` and is replayed from the start next round.
      const nextCursor =
        typeof page.next_cursor === "string" ? page.next_cursor : null
      if (page.has_more !== entry.hasMore || nextCursor !== entry.cursor) {
        advanced = true
      }
      entry.hasMore = page.has_more
      entry.cursor = nextCursor
    }
    // Progress is either new records or a moved cursor. Without both, replaying
    // an all-duplicate page would spin forever.
    if (accepted === 0 && !advanced) break
    remaining -= accepted
  }

  return pending.map(entry => ({
    ...entry.streamRead,
    records: entry.records,
    hasMore: entry.hasMore,
    cursor: entry.cursor,
  }))
}

function humanizeStreamName(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
