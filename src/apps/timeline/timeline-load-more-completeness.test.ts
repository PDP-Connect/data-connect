// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { TimelineRead } from "./timeline-data-source"

const readLocalTimeline = vi.fn()
const capability = { clientId: "dataconnect.timeline", accessToken: "pdpp" }

// `loadMore` resolves this module once and then fans out concurrently, so a
// single mock here covers every stream without racing the dynamic import.
vi.mock("@/services/pdppTimeline", () => ({
  readLocalTimeline,
  getLocalTimelineCapability: () => capability,
  clearLocalTimelineCapability: vi.fn(),
  PdppTimelineRequestError: class extends Error {},
}))

import { createProductionTimelineDataSource } from "./timeline-data-source"

const RECORDS_PER_STREAM = 3

/**
 * Serves one record per page, so a cursor that advances past an unconsumed
 * record makes that record permanently unreachable.
 */
function servePage(streamId: string, offset: number) {
  const id = `${streamId}-record-${offset}`
  const hasMore = offset + 1 < RECORDS_PER_STREAM
  return {
    data: offset < RECORDS_PER_STREAM ? [{ id, data: { id } }] : [],
    has_more: hasMore,
    next_cursor: hasMore ? `${streamId}:${offset + 1}` : null,
  }
}

function initialRead(streamIds: readonly string[]): TimelineRead {
  return {
    streams: streamIds.map(id => ({
      stream: {
        id,
        label: id,
        fields: [{ name: "id" }],
        primaryKey: ["id"],
        timestampFields: [],
      },
      records: [],
      hasMore: true,
      cursor: `${id}:0`,
    })),
  }
}

beforeEach(() => {
  readLocalTimeline.mockReset()
  readLocalTimeline.mockImplementation((_port: number, path: string) => {
    const match = /^\/v1\/streams\/([^/]+)\/records\?(.*)$/.exec(path)
    if (!match) throw new Error(`unexpected path ${path}`)
    const streamId = decodeURIComponent(match[1])
    const cursor = new URLSearchParams(match[2]).get("cursor")
    const offset = cursor ? Number(cursor.split(":")[1]) : 0
    return Promise.resolve(servePage(streamId, offset))
  })
})

describe("Timeline load more completeness", () => {
  it.each([
    { label: "one remaining slot", streamCount: 2, maxRecords: 1 },
    {
      label: "one slot fewer than active streams",
      streamCount: 4,
      maxRecords: 3,
    },
  ])(
    "returns every record exactly once across repeated loads with $label",
    async ({ streamCount, maxRecords }) => {
      const streamIds = Array.from(
        { length: streamCount },
        (_, index) => `stream-${index}`
      )
      const dataSource = createProductionTimelineDataSource({
        port: 3100,
        devToken: "desktop-secret",
      })

      const idsOf = (value: TimelineRead) =>
        value.streams.map(stream => stream.records.map(record => record.id))

      let read = initialRead(streamIds)
      const maxLoads = streamCount * RECORDS_PER_STREAM + 5
      let loads = 0
      while (read.streams.some(stream => stream.hasMore)) {
        if (++loads > maxLoads) throw new Error("pagination did not terminate")
        const before = idsOf(read)
        const beforeTotal = before.reduce((sum, ids) => sum + ids.length, 0)
        const next = await dataSource.loadMore?.(read, {
          maxStreams: 24,
          maxRecords,
          signal: new AbortController().signal,
        })
        if (next?.kind !== "ready") {
          throw new Error(`expected ready, got ${JSON.stringify(next)}`)
        }
        const after = idsOf(next.read)
        const afterTotal = after.reduce((sum, ids) => sum + ids.length, 0)

        // The global record bound still caps how much one call may add.
        expect(afterTotal - beforeTotal).toBeLessThanOrEqual(maxRecords)
        // Already loaded records keep their position; new ones only append.
        after.forEach((ids, index) => {
          expect(ids.slice(0, before[index].length)).toEqual(before[index])
        })
        read = next.read
      }

      // An exhausted stream must not keep a cursor that was never consumed.
      for (const stream of read.streams) {
        expect(stream.hasMore).toBe(false)
        expect(stream.cursor).toBeNull()
      }

      const collected = read.streams.flatMap(stream =>
        stream.records.map(record => record.id)
      )
      const expected = streamIds.flatMap(id =>
        Array.from(
          { length: RECORDS_PER_STREAM },
          (_, offset) => `${id}-record-${offset}`
        )
      )
      // The record the budget boundary used to drop is present exactly once.
      expect(collected.filter(id => id === "stream-1-record-0")).toEqual([
        "stream-1-record-0",
      ])
      expect(new Set(collected).size).toBe(collected.length)
      expect([...collected].sort()).toEqual([...expected].sort())
    }
  )
})
