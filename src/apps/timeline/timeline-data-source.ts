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
  data: Array<{ name: string; record_count?: number }>
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
            return { kind: "revoked" }
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
            return { kind: "revoked" }
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
    hasMore: true,
  }))
  let remaining = Math.max(0, maxRecords)

  while (remaining > 0) {
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
          `/v1/streams/${encodeURIComponent(entry.stream.name)}/records?limit=${pageLimit}${entry.cursor ? `&cursor=${encodeURIComponent(entry.cursor)}` : ""}`,
          capability,
          signal
        ),
      }))
    )
    let added = 0
    for (const { entry, page } of pages) {
      const pageRecords = page.data.slice(0, remaining - added)
      entry.records.push(...pageRecords)
      added += pageRecords.length
      entry.hasMore = page.has_more && pageRecords.length === page.data.length
      entry.cursor =
        typeof page.next_cursor === "string" ? page.next_cursor : null
      if (entry.hasMore && !entry.cursor) entry.hasMore = false
    }
    if (added === 0) break
    remaining -= added
  }

  return pending.map(entry => {
    const fieldNames = new Set<string>()
    for (const record of entry.records) {
      Object.keys(record.data).forEach(field => fieldNames.add(field))
    }
    return {
      stream: {
        id: entry.stream.name,
        label: humanizeStreamName(entry.stream.name),
        fields: Array.from(fieldNames, name => ({ name })),
        primaryKey: [],
        timestampFields: [],
        recordCount: entry.stream.record_count,
      },
      records: entry.records,
      hasMore: entry.hasMore,
      cursor: entry.cursor,
    }
  })
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
    const active = pending.filter(entry => entry.hasMore && entry.cursor)
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
          `/v1/streams/${encodeURIComponent(entry.streamRead.stream.id)}/records?limit=${pageLimit}&cursor=${encodeURIComponent(entry.cursor!)}`,
          capability,
          signal
        ),
      }))
    )
    let accepted = 0
    let fetched = 0
    for (const { entry, page } of pages) {
      fetched += page.data.length
      for (const record of page.data) {
        if (accepted >= remaining) break
        if (entry.seenIds.has(record.id)) continue
        entry.seenIds.add(record.id)
        entry.records.push(record)
        accepted += 1
      }
      entry.hasMore = page.has_more
      entry.cursor =
        typeof page.next_cursor === "string" ? page.next_cursor : null
      if (entry.hasMore && !entry.cursor) entry.hasMore = false
    }
    if (fetched === 0) break
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
