import { describe, expect, it } from "vitest"
import { deriveTimeline } from "./timeline-derivation"
import type { TimelineRead } from "./timeline-data-source"

const read: TimelineRead = {
  streams: [
    {
      stream: {
        id: "messages",
        label: "Messages",
        fields: [
          { name: "createdAt", format: "date-time" },
          { name: "publishedAt", format: "date-time" },
          { name: "title" },
        ],
        primaryKey: ["messageId"],
        timestampFields: ["createdAt", "publishedAt"],
      },
      records: [
        {
          id: "message-1",
          data: {
            createdAt: "not a date",
            publishedAt: "2026-07-29T14:00:00Z",
            title: "Published message",
          },
        },
        {
          id: "message-2",
          data: { createdAt: "2026-07-30", messageId: "fallback-key" },
        },
      ],
      hasMore: false,
    },
    {
      stream: {
        id: "activity",
        label: "Activity",
        fields: [{ name: "event_time" }, { name: "name" }],
        primaryKey: [],
        timestampFields: [],
      },
      records: [
        {
          id: "activity-1",
          data: { event_time: 1_785_392_400, name: "Epoch event" },
        },
        {
          id: "activity-2",
          data: { name: "Undated activity" },
        },
      ],
      hasMore: true,
    },
  ],
}

describe("deriveTimeline", () => {
  it("prioritizes manifest timestamp fields and falls through invalid values", () => {
    const timeline = deriveTimeline(read, { maxRecords: 100, maxStreams: 24 })

    expect(timeline.dayGroups[0]).toMatchObject({
      dayKey: "2026-07-30",
      events: [
        {
          recordId: "activity-1",
          streamId: "activity",
          streamLabel: "Activity",
          timestampField: "event_time",
          label: "Epoch event",
        },
        {
          recordId: "message-2",
          timestampField: "createdAt",
          label: "fallback-key",
        },
      ],
    })
    expect(timeline.dayGroups[1]).toMatchObject({
      dayKey: "2026-07-29",
      events: [
        {
          recordId: "message-1",
          timestampField: "publishedAt",
          label: "Published message",
        },
      ],
    })
  })

  it("keeps records without a usable date in an explicit undated collection", () => {
    const timeline = deriveTimeline(read, { maxRecords: 100, maxStreams: 24 })

    expect(timeline.undatedRecords).toEqual([
      {
        recordId: "activity-2",
        streamId: "activity",
        streamLabel: "Activity",
        label: "Undated activity",
        reason: "no-usable-timestamp",
      },
    ])
  })

  it("rejects non-ISO date strings and does not use object values as labels", () => {
    const timeline = deriveTimeline(
      {
        streams: [
          {
            stream: {
              id: "records",
              label: "Records",
              fields: [{ name: "date" }, { name: "title" }],
              primaryKey: [],
              timestampFields: ["date"],
            },
            records: [
              {
                id: "record-1",
                data: { date: "yesterday", title: { nested: "value" } },
              },
            ],
            hasMore: false,
          },
        ],
      },
      { maxRecords: 100, maxStreams: 24 }
    )

    expect(timeline.dayGroups).toEqual([])
    expect(timeline.undatedRecords[0]?.label).toBe("record-1")
  })

  it("bounds work and tells callers when more records may exist", () => {
    const timeline = deriveTimeline(read, { maxRecords: 2, maxStreams: 24 })

    expect(timeline.processedRecordCount).toBe(2)
    expect(timeline.omittedRecordCount).toBe(2)
    expect(timeline.isTruncated).toBe(true)
  })

  it("bounds streams even when a data source over-delivers", () => {
    const timeline = deriveTimeline(read, { maxRecords: 100, maxStreams: 1 })

    expect(timeline.streams).toEqual([{ id: "messages", label: "Messages" }])
    expect(timeline.processedRecordCount).toBe(2)
    expect(timeline.undatedRecords).toEqual([])
    expect(timeline.isTruncated).toBe(true)
  })

  it("uses UTC day groups at a midnight boundary", () => {
    const timeline = deriveTimeline(
      {
        streams: [
          {
            stream: {
              id: "events",
              label: "Events",
              fields: [{ name: "timestamp" }, { name: "name" }],
              primaryKey: [],
              timestampFields: ["timestamp"],
            },
            records: [
              {
                id: "event-1",
                data: {
                  timestamp: "2026-07-30T00:30:00Z",
                  name: "Midnight boundary",
                },
              },
            ],
            hasMore: false,
          },
        ],
      },
      { maxRecords: 100, maxStreams: 24 }
    )

    expect(timeline.dayGroups[0]?.dayKey).toBe("2026-07-30")
  })
})
