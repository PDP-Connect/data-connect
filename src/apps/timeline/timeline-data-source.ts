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

/**
 * A future adapter owns PDPP stream discovery and opaque cursor pagination.
 * The timeline only receives a bounded, transport-independent read result.
 */
export interface TimelineDataSource {
  read(options: TimelineReadOptions): Promise<TimelineReadResult>
}

export const productionTimelineDataSource: TimelineDataSource = {
  async read() {
    return {
      kind: "error",
      code: "unavailable",
      message: "Timeline reads are not connected to your Personal Server yet.",
      retryable: false,
    }
  },
}
