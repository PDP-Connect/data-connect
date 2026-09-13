// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { TimelineRead } from "./timeline-data-source"

const readLocalTimeline = vi.fn()
const capability = { clientId: "dataconnect.timeline", accessToken: "pdpp" }

// Both `read` and `loadMore` resolve this module once and then fan out
// concurrently, so a single mock here covers every stream without racing the
// dynamic import.
vi.mock("@/services/pdppTimeline", () => ({
  readLocalTimeline,
  getLocalTimelineCapability: () => capability,
  clearLocalTimelineCapability: vi.fn(),
  PdppTimelineRequestError: class extends Error {},
}))

import { createProductionTimelineDataSource } from "./timeline-data-source"

/**
 * A stream backed by a fixed record list. `serve` answers a records request the
 * way PDPP does: an offset cursor, a page bounded by `limit`, and `has_more`
 * describing the source rather than the caller's budget.
 */
function createStreamSource(id: string, recordCount: number) {
  return {
    id,
    recordCount,
    ids: Array.from({ length: recordCount }, (_, i) => `${id}-record-${i}`),
    serve(offset: number, limit: number) {
      const slice = this.ids.slice(offset, offset + limit)
      const next = offset + slice.length
      const hasMore = next < recordCount
      return {
        data: slice.map(recordId => ({ id: recordId, data: { id: recordId } })),
        has_more: hasMore,
        next_cursor: hasMore ? `${id}:${next}` : null,
      }
    },
  }
}

function installSources(sources: readonly ReturnType<typeof createStreamSource>[]) {
  readLocalTimeline.mockReset()
  readLocalTimeline.mockImplementation((_port: number, path: string) => {
    if (path === "/v1/streams") {
      return Promise.resolve({
        data: sources.map(source => ({
          name: source.id,
          record_count: source.recordCount,
        })),
      })
    }
    const match = /^\/v1\/streams\/([^/]+)\/records\?(.*)$/.exec(path)
    if (!match) throw new Error(`unexpected path ${path}`)
    const streamId = decodeURIComponent(match[1])
    const params = new URLSearchParams(match[2])
    const cursor = params.get("cursor")
    const limit = Number(params.get("limit"))
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`invalid limit ${params.get("limit")} for ${streamId}`)
    }
    const source = sources.find(entry => entry.id === streamId)
    if (!source) throw new Error(`unknown stream ${streamId}`)
    const offset = cursor ? Number(cursor.split(":")[1]) : 0
    return Promise.resolve(source.serve(offset, limit))
  })
}

const idsOf = (value: TimelineRead) =>
  value.streams.map(stream => stream.records.map(record => record.id))
const totalOf = (value: TimelineRead) =>
  idsOf(value).reduce((sum, ids) => sum + ids.length, 0)

/**
 * Drives the real `read()` and then `loadMore()` to exhaustion, asserting the
 * per-call budget and append-only ordering on every step.
 */
async function drainTimeline(
  sources: readonly ReturnType<typeof createStreamSource>[],
  maxRecords: number
) {
  installSources(sources)
  const dataSource = createProductionTimelineDataSource({
    port: 3100,
    devToken: "desktop-secret",
  })

  const first = await dataSource.read({
    maxStreams: 24,
    maxRecords,
    signal: new AbortController().signal,
  })
  if (first.kind !== "ready") {
    throw new Error(`expected ready, got ${JSON.stringify(first)}`)
  }
  // The initial read honours the same global bound as every later call.
  expect(totalOf(first.read)).toBeLessThanOrEqual(maxRecords)

  let read = first.read
  const totalRecords = sources.reduce((sum, s) => sum + s.recordCount, 0)
  const maxLoads = totalRecords + sources.length + 5
  let loads = 0
  while (read.streams.some(stream => stream.hasMore)) {
    if (++loads > maxLoads) throw new Error("pagination did not terminate")
    const before = idsOf(read)
    const beforeTotal = totalOf(read)
    const next = await dataSource.loadMore?.(read, {
      maxStreams: 24,
      maxRecords,
      signal: new AbortController().signal,
    })
    if (next?.kind !== "ready") {
      throw new Error(`expected ready, got ${JSON.stringify(next)}`)
    }
    // The global record bound still caps how much one call may add.
    expect(totalOf(next.read) - beforeTotal).toBeLessThanOrEqual(maxRecords)
    // Already loaded records keep their position; new ones only append.
    idsOf(next.read).forEach((ids, index) => {
      expect(ids.slice(0, before[index].length)).toEqual(before[index])
    })
    read = next.read
  }

  return read
}

function expectCompleteAndUnique(
  read: TimelineRead,
  sources: readonly ReturnType<typeof createStreamSource>[]
) {
  // Termination leaves no stream claiming more records are available.
  for (const stream of read.streams) {
    expect(stream.hasMore).toBe(false)
  }
  const collected = read.streams.flatMap(stream =>
    stream.records.map(record => record.id)
  )
  const expected = sources.flatMap(source => source.ids)
  // Uniqueness: every record appears exactly once.
  expect(new Set(collected).size).toBe(collected.length)
  // Completeness: budget exhaustion never became source exhaustion.
  expect([...collected].sort()).toEqual([...expected].sort())
}

beforeEach(() => {
  readLocalTimeline.mockReset()
})

describe("Timeline initial read completeness", () => {
  it.each([
    // Both externally reported cases, at the shipped default limits.
    { label: "24 streams x 10 records, budget 100", streams: 24, perStream: 10, maxRecords: 100 },
    { label: "2 streams x 3 records, budget 1", streams: 2, perStream: 3, maxRecords: 1 },
  ])(
    "reaches every record through read() then loadMore() with $label",
    async ({ streams, perStream, maxRecords }) => {
      const sources = Array.from({ length: streams }, (_, index) =>
        createStreamSource(`stream-${index}`, perStream)
      )
      const read = await drainTimeline(sources, maxRecords)
      expectCompleteAndUnique(read, sources)
    }
  )

  it("reaches a stream whose first page could not be admitted at all", async () => {
    // Budget 2 over 3 streams: the residual round admits nothing for the last
    // stream, so it is only reachable if a never-consumed page stays replayable.
    const sources = [
      createStreamSource("alpha", 4),
      createStreamSource("beta", 4),
      createStreamSource("gamma", 4),
    ]
    const read = await drainTimeline(sources, 2)
    expectCompleteAndUnique(read, sources)

    const gamma = read.streams.find(stream => stream.stream.id === "gamma")
    expect(gamma?.records.map(record => record.id)).toEqual([
      "gamma-record-0",
      "gamma-record-1",
      "gamma-record-2",
      "gamma-record-3",
    ])
  })

  it("terminates when a source claims more records but sends no cursor", async () => {
    // The server contract pairs `has_more: true` with a cursor. A source that
    // breaks it must still not spin the replay loop forever.
    readLocalTimeline.mockReset()
    readLocalTimeline.mockImplementation((_port: number, path: string) => {
      if (path === "/v1/streams") {
        return Promise.resolve({ data: [{ name: "stuck", record_count: 2 }] })
      }
      return Promise.resolve({
        data: [{ id: "stuck-record-0", data: { id: "stuck-record-0" } }],
        has_more: true,
        next_cursor: null,
      })
    })
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    const first = await dataSource.read({
      maxStreams: 24,
      maxRecords: 10,
      signal: new AbortController().signal,
    })
    if (first.kind !== "ready") throw new Error("expected ready")
    // One record, admitted once, and the read returned instead of looping.
    expect(idsOf(first.read)).toEqual([["stuck-record-0"]])

    const next = await dataSource.loadMore?.(first.read, {
      maxStreams: 24,
      maxRecords: 10,
      signal: new AbortController().signal,
    })
    if (next?.kind !== "ready") throw new Error("expected ready")
    // Replay re-reads the same page, dedupes it, and stops.
    expect(idsOf(next.read)).toEqual([["stuck-record-0"]])
  })

  it("never reports source exhaustion for a stream the budget cut short", async () => {
    // 24 streams and a budget of 100 forces a residual round that can only
    // serve some of the active streams.
    const sources = Array.from({ length: 24 }, (_, index) =>
      createStreamSource(`stream-${index}`, 10)
    )
    installSources(sources)
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })

    const first = await dataSource.read({
      maxStreams: 24,
      maxRecords: 100,
      signal: new AbortController().signal,
    })
    if (first.kind !== "ready") throw new Error("expected ready")

    // Every stream still holds 10 records, so none may claim to be exhausted
    // after an initial read that admitted only 100 of 240.
    expect(totalOf(first.read)).toBe(100)
    for (const stream of first.read.streams) {
      const loaded = stream.records.length
      expect(stream.hasMore, `${stream.stream.id} loaded ${loaded} of 10`).toBe(
        true
      )
    }
  })
})
