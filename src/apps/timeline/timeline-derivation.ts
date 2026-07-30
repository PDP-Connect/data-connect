import type {
  TimelineField,
  TimelineRead,
  TimelineStream,
} from "./timeline-data-source"

export type TimelineEvent = {
  recordId: string
  streamId: string
  streamLabel: string
  timestampMs: number
  timestampField: string
  label: string
}

export type TimelineUndatedRecord = {
  recordId: string
  streamId: string
  streamLabel: string
  label: string
  reason: "no-usable-timestamp"
}

export type TimelineDayGroup = {
  dayKey: string
  events: readonly TimelineEvent[]
}

export type DerivedTimeline = {
  streams: readonly { id: string; label: string }[]
  dayGroups: readonly TimelineDayGroup[]
  undatedRecords: readonly TimelineUndatedRecord[]
  processedRecordCount: number
  omittedRecordCount: number
  isTruncated: boolean
}

type TimestampCandidate = {
  name: string
  acceptsEpoch: boolean
}

const commonLabelFields = [
  "title",
  "name",
  "subject",
  "summary",
  "label",
  "text",
  "description",
  "message",
] as const

const knownTimestampFields = new Set([
  "event_time",
  "occurred_at",
  "published_at",
  "created_at",
  "updated_at",
  "timestamp",
  "date",
])

const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/
const dateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

export function deriveTimeline(
  read: TimelineRead,
  {
    maxRecords,
    maxStreams,
  }: {
    maxRecords: number
    maxStreams: number
  }
): DerivedTimeline {
  const boundedRecordCount = Math.max(0, Math.floor(maxRecords))
  const boundedStreamCount = Math.max(0, Math.floor(maxStreams))
  const streams = read.streams.slice(0, boundedStreamCount)
  const availableRecordCount = streams.reduce(
    (count, { records }) => count + records.length,
    0
  )
  const datedEvents: TimelineEvent[] = []
  const undatedRecords: TimelineUndatedRecord[] = []
  let processedRecordCount = 0

  for (const { stream, records } of streams) {
    const timestampCandidates = getTimestampCandidates(stream)

    for (const record of records) {
      if (processedRecordCount >= boundedRecordCount) {
        break
      }

      processedRecordCount += 1
      const label = getRecordLabel(record.data, stream, record.id)
      const timestamp = findTimestamp(record.data, timestampCandidates)

      if (!timestamp) {
        undatedRecords.push({
          recordId: record.id,
          streamId: stream.id,
          streamLabel: stream.label,
          label,
          reason: "no-usable-timestamp",
        })
        continue
      }

      datedEvents.push({
        recordId: record.id,
        streamId: stream.id,
        streamLabel: stream.label,
        timestampMs: timestamp.value,
        timestampField: timestamp.field,
        label,
      })
    }

    if (processedRecordCount >= boundedRecordCount) {
      break
    }
  }

  datedEvents.sort(compareTimelineEvents)
  undatedRecords.sort(compareTimelineRecords)

  const groups = new Map<string, TimelineEvent[]>()
  for (const event of datedEvents) {
    const dayKey = new Date(event.timestampMs).toISOString().slice(0, 10)
    const events = groups.get(dayKey) ?? []
    events.push(event)
    groups.set(dayKey, events)
  }

  return {
    streams: streams.map(({ stream }) => ({
      id: stream.id,
      label: stream.label,
    })),
    dayGroups: Array.from(groups, ([dayKey, events]) => ({ dayKey, events })),
    undatedRecords,
    processedRecordCount,
    omittedRecordCount: Math.max(
      0,
      availableRecordCount - processedRecordCount
    ),
    isTruncated:
      availableRecordCount > processedRecordCount ||
      read.streams.length > streams.length ||
      streams.some(streamRead => streamRead.hasMore),
  }
}

export function filterTimeline(
  timeline: DerivedTimeline,
  streamId: string | null
): DerivedTimeline {
  if (!streamId) {
    return timeline
  }

  const dayGroups = timeline.dayGroups
    .map(group => ({
      ...group,
      events: group.events.filter(event => event.streamId === streamId),
    }))
    .filter(group => group.events.length > 0)
  const undatedRecords = timeline.undatedRecords.filter(
    record => record.streamId === streamId
  )

  return {
    ...timeline,
    dayGroups,
    undatedRecords,
    processedRecordCount:
      dayGroups.reduce((count, group) => count + group.events.length, 0) +
      undatedRecords.length,
  }
}

function getTimestampCandidates(stream: TimelineStream): TimestampCandidate[] {
  const fields = new Map(stream.fields.map(field => [field.name, field]))
  const candidates = new Map<string, TimestampCandidate>()
  const addCandidate = (name: string, field?: TimelineField) => {
    if (candidates.has(name)) {
      return
    }

    const normalizedName = normalizeFieldName(name)
    const hasDateFormat =
      field?.format === "date" || field?.format === "date-time"
    candidates.set(name, {
      name,
      acceptsEpoch:
        hasDateFormat ||
        knownTimestampFields.has(normalizedName) ||
        normalizedName.includes("timestamp") ||
        normalizedName.endsWith("_at"),
    })
  }

  for (const fieldName of stream.timestampFields) {
    addCandidate(fieldName, fields.get(fieldName))
  }
  for (const field of stream.fields) {
    if (field.format === "date" || field.format === "date-time") {
      addCandidate(field.name, field)
    }
  }
  for (const field of stream.fields) {
    if (isDateLikeFieldName(field.name)) {
      addCandidate(field.name, field)
    }
  }

  return Array.from(candidates.values())
}

function findTimestamp(
  data: Readonly<Record<string, unknown>>,
  candidates: readonly TimestampCandidate[]
): { field: string; value: number } | null {
  for (const candidate of candidates) {
    const value = parseTimestamp(data[candidate.name], candidate)
    if (value !== null) {
      return { field: candidate.name, value }
    }
  }

  return null
}

function parseTimestamp(
  value: unknown,
  candidate: TimestampCandidate
): number | null {
  if (typeof value === "number" && candidate.acceptsEpoch) {
    const milliseconds =
      Math.abs(value) < 100_000_000_000 ? value * 1000 : value
    return isValidTimestamp(milliseconds) ? milliseconds : null
  }

  if (typeof value !== "string") {
    return null
  }

  const dateOnlyMatch = value.match(dateOnlyPattern)
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch
    const milliseconds = Date.UTC(Number(year), Number(month) - 1, Number(day))
    return isValidCalendarDay(year, month, day, milliseconds)
      ? milliseconds
      : null
  }

  const dateTimeMatch = value.match(dateTimePattern)
  if (!dateTimeMatch) {
    return null
  }

  const [, year, month, day] = dateTimeMatch
  if (!isValidCalendarDay(year, month, day)) {
    return null
  }
  const milliseconds = Date.parse(value)
  return isValidTimestamp(milliseconds) ? milliseconds : null
}

function getRecordLabel(
  data: Readonly<Record<string, unknown>>,
  stream: TimelineStream,
  recordId: string
): string {
  for (const labelField of commonLabelFields) {
    for (const [fieldName, value] of Object.entries(data)) {
      if (normalizeFieldName(fieldName) === labelField) {
        const label = toLabel(value)
        if (label) return label
      }
    }
  }

  for (const fieldName of stream.primaryKey) {
    const label = toLabel(data[fieldName])
    if (label) return label
  }

  return recordId
}

function toLabel(value: unknown): string | null {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : ""

  if (!text) {
    return null
  }

  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

function compareTimelineEvents(
  left: TimelineEvent,
  right: TimelineEvent
): number {
  return (
    right.timestampMs - left.timestampMs ||
    left.streamId.localeCompare(right.streamId) ||
    left.recordId.localeCompare(right.recordId)
  )
}

function compareTimelineRecords(
  left: TimelineUndatedRecord,
  right: TimelineUndatedRecord
): number {
  return (
    left.streamId.localeCompare(right.streamId) ||
    left.recordId.localeCompare(right.recordId)
  )
}

function normalizeFieldName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
}

function isDateLikeFieldName(name: string): boolean {
  const normalizedName = normalizeFieldName(name)
  return (
    knownTimestampFields.has(normalizedName) ||
    normalizedName.endsWith("_at") ||
    normalizedName.endsWith("_date")
  )
}

function isValidCalendarDay(
  year: string,
  month: string,
  day: string,
  milliseconds = Date.UTC(Number(year), Number(month) - 1, Number(day))
): boolean {
  if (!isValidTimestamp(milliseconds)) {
    return false
  }

  const date = new Date(milliseconds)
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  )
}

function isValidTimestamp(milliseconds: number): boolean {
  return (
    Number.isFinite(milliseconds) &&
    !Number.isNaN(new Date(milliseconds).valueOf())
  )
}
