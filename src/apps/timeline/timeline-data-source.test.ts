// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauriFetch = vi.fn()
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: tauriFetch }))

import { createProductionTimelineDataSource } from "./timeline-data-source"
import {
  clearLocalTimelineCapability,
  getLocalTimelineCapability,
  revokeLocalTimelineConsent,
} from "@/services/pdppTimeline"

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

function localConsent(init: RequestInit, requestId: string) {
  const body = JSON.parse(String(init.body))
  return response({
    request_id: requestId,
    session_id: body.session_id,
    subject_id: body.subject_id,
    scopes: ["pdpp.local.github.repositories"],
    access_expires_in_seconds: 28_800,
    authorization_details: {
      type: "https://pdpp.org/data-access",
      source: { kind: "connector", id: "github" },
      access_mode: "continuous",
      purpose_code: "https://dataconnect.app/purposes/timeline",
      purpose_description:
        "Show your connected records in DataConnect's local Timeline.",
      streams: [{ name: "repositories" }],
    },
  })
}

beforeEach(() => {
  tauriFetch.mockReset()
  clearLocalTimelineCapability()
  localStorage.clear()
  history.replaceState({}, "", "/apps/timeline")
})

describe("production Timeline PDPP data source", () => {
  it("requires explicit consent before it reads", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })

    await expect(
      dataSource.read({
        maxStreams: 24,
        maxRecords: 100,
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ kind: "unauthorized" })
    expect(tauriFetch).not.toHaveBeenCalled()
  })

  it("loads normalized local terms before explicit approval, then reads over PDPP", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    tauriFetch
      .mockImplementationOnce((_url, init) => localConsent(init, "request-1"))
      .mockResolvedValueOnce(
        response({ access_token: "pdpp-bearer", token_type: "Bearer" }, 201)
      )
      .mockResolvedValueOnce(
        response({ data: [{ name: "repositories", record_count: 1 }] })
      )
      .mockResolvedValueOnce(
        response({
          data: [
            {
              id: "repo-1",
              data: {
                id: "repo-1",
                name: "DataConnect",
                pushed_at: "2026-07-30T12:00:00Z",
              },
            },
          ],
          has_more: true,
        })
      )

    const consent = await dataSource.requestConsent?.()
    expect(consent?.authorization_details.streams).toEqual([
      { name: "repositories" },
    ])
    expect(tauriFetch).toHaveBeenCalledOnce()
    expect(getLocalTimelineCapability()).toBeNull()
    expect(tauriFetch.mock.calls[0][0]).not.toContain("desktop-secret")

    await dataSource.approveConsent?.(consent!)
    const capability = getLocalTimelineCapability()
    expect(capability).toMatchObject({
      clientId: "dataconnect.timeline",
      accessToken: "pdpp-bearer",
    })
    expect(localStorage.length).toBe(0)
    expect(location.pathname).toBe("/apps/timeline")

    const result = await dataSource.read({
      maxStreams: 24,
      maxRecords: 100,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      kind: "ready",
      read: {
        streams: [
          {
            stream: {
              id: "repositories",
              fields: expect.arrayContaining([{ name: "pushed_at" }]),
            },
            records: [{ id: "repo-1" }],
            hasMore: false,
          },
        ],
      },
    })
    const calls = tauriFetch.mock.calls
    expect(calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/v1/pdpp/local-timeline/consent-requests",
      "http://127.0.0.1:3100/v1/pdpp/local-timeline/consent-requests/request-1/approve",
      "http://127.0.0.1:3100/v1/streams",
      "http://127.0.0.1:3100/v1/streams/repositories/records?limit=100",
    ])
    expect(calls[0][1].headers.Authorization).toBe("Bearer desktop-secret")
    expect(calls[1][1].headers.Authorization).toBe("Bearer desktop-secret")
    expect(calls[2][1].headers.Authorization).toBe("Bearer pdpp-bearer")
    expect(calls.map(([url]) => url).join("\n")).not.toContain("pdpp-bearer")
  })

  it("uses stream-list metadata when the first page is projected", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    tauriFetch.mockImplementation((url, init) => {
      const path = String(url).replace("http://127.0.0.1:3100", "")
      if (path === "/v1/pdpp/local-timeline/consent-requests") {
        return Promise.resolve(localConsent(init, "request-metadata"))
      }
      if (
        path ===
        "/v1/pdpp/local-timeline/consent-requests/request-metadata/approve"
      ) {
        return Promise.resolve(
          response({ access_token: "pdpp-metadata", token_type: "Bearer" }, 201)
        )
      }
      if (path === "/v1/streams") {
        return Promise.resolve(
          response({
            data: [
              {
                name: "repositories",
                record_count: 1,
                fields: [
                  { name: "id", type: "string" },
                  {
                    name: "source_created_at",
                    type: "string",
                    format: "date-time",
                  },
                  {
                    name: "source_updated_at",
                    type: "string",
                    format: "date-time",
                  },
                  { name: "name", type: "string" },
                ],
                primary_key: ["id"],
                timestamp_fields: ["source_created_at", "source_updated_at"],
              },
            ],
          })
        )
      }
      if (path.startsWith("/v1/streams/repositories/records?")) {
        return Promise.resolve(
          response({
            data: [{ id: "repo-1", data: { id: "repo-1", name: "projected" } }],
            has_more: false,
          })
        )
      }
      throw new Error(`unexpected URL ${path}`)
    })

    const consent = await dataSource.requestConsent?.()
    await dataSource.approveConsent?.(consent!)
    const result = await dataSource.read({
      maxStreams: 24,
      maxRecords: 100,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      kind: "ready",
      read: {
        streams: [
          {
            stream: {
              id: "repositories",
              primaryKey: ["id"],
              timestampFields: ["source_created_at", "source_updated_at"],
              fields: expect.arrayContaining([
                {
                  name: "source_created_at",
                  type: "string",
                  format: "date-time",
                },
              ]),
            },
            records: [{ id: "repo-1" }],
          },
        ],
      },
    })
  })

  it("keeps empty stream metadata without record-derived fields", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    tauriFetch
      .mockImplementationOnce((_url, init) =>
        localConsent(init, "request-empty-metadata")
      )
      .mockResolvedValueOnce(
        response({ access_token: "pdpp-empty", token_type: "Bearer" }, 201)
      )
      .mockResolvedValueOnce(
        response({
          data: [
            {
              name: "empty_stream",
              record_count: 0,
              fields: [
                { name: "id", type: "string" },
                { name: "created_at", type: "string", format: "date-time" },
              ],
              primary_key: ["id"],
              timestamp_fields: ["created_at"],
            },
          ],
        })
      )

    const consent = await dataSource.requestConsent?.()
    await dataSource.approveConsent?.(consent!)
    const result = await dataSource.read({
      maxStreams: 24,
      maxRecords: 0,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      kind: "ready",
      read: {
        streams: [
          {
            stream: {
              id: "empty_stream",
              primaryKey: ["id"],
              timestampFields: ["created_at"],
              fields: expect.arrayContaining([
                { name: "created_at", type: "string", format: "date-time" },
              ]),
            },
            records: [],
          },
        ],
      },
    })
    expect(tauriFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/v1/pdpp/local-timeline/consent-requests",
      "http://127.0.0.1:3100/v1/pdpp/local-timeline/consent-requests/request-empty-metadata/approve",
      "http://127.0.0.1:3100/v1/streams",
    ])
  })

  it("follows opaque cursors without exceeding the global record bound", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    tauriFetch
      .mockImplementationOnce((_url, init) =>
        localConsent(init, "request-pages")
      )
      .mockResolvedValueOnce(
        response({ access_token: "pdpp-pages", token_type: "Bearer" }, 201)
      )
      .mockResolvedValueOnce(response({ data: [{ name: "repositories" }] }))
      .mockResolvedValueOnce(
        response({
          data: [{ id: "one", data: { id: "one" } }],
          has_more: true,
          next_cursor: "opaque:2",
        })
      )
      .mockResolvedValueOnce(
        response({
          data: [{ id: "two", data: { id: "two" } }],
          has_more: true,
          next_cursor: "opaque:3",
        })
      )
    const consent = await dataSource.requestConsent?.()
    await dataSource.approveConsent?.(consent!)
    const result = await dataSource.read({
      maxStreams: 24,
      maxRecords: 2,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      kind: "ready",
      read: {
        streams: [{ records: [{ id: "one" }, { id: "two" }], hasMore: true }],
      },
    })
    expect(tauriFetch.mock.calls.slice(2).map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/v1/streams",
      "http://127.0.0.1:3100/v1/streams/repositories/records?limit=2",
      "http://127.0.0.1:3100/v1/streams/repositories/records?limit=1&cursor=opaque%3A2",
    ])
  })

  it("loads the next bounded page from a saved stream cursor and dedupes records", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    tauriFetch.mockImplementation((url, init) => {
      const path = String(url).replace("http://127.0.0.1:3100", "")
      if (path === "/v1/pdpp/local-timeline/consent-requests") {
        return Promise.resolve(localConsent(init, "request-more"))
      }
      if (
        path === "/v1/pdpp/local-timeline/consent-requests/request-more/approve"
      ) {
        return Promise.resolve(
          response({ access_token: "pdpp-more", token_type: "Bearer" }, 201)
        )
      }
      if (path === "/v1/streams") {
        return Promise.resolve(
          response({
            data: [{ name: "repositories" }],
          })
        )
      }
      if (
        path.startsWith("/v1/streams/repositories/records?") &&
        !path.includes("cursor=")
      ) {
        return Promise.resolve(
          response({
            data: [{ id: "repo-1", data: { id: "repo-1" } }],
            has_more: true,
            next_cursor: "repo:2",
          })
        )
      }
      if (
        path.startsWith("/v1/streams/repositories/records?") &&
        path.includes("cursor=repo%3A2")
      ) {
        return Promise.resolve(
          response({
            data: [
              { id: "repo-1", data: { id: "repo-1-duplicate" } },
              { id: "repo-2", data: { id: "repo-2" } },
            ],
            has_more: false,
          })
        )
      }
      throw new Error(`unexpected URL ${path}`)
    })

    const consent = await dataSource.requestConsent?.()
    await dataSource.approveConsent?.(consent!)
    const first = await dataSource.read({
      maxStreams: 24,
      maxRecords: 1,
      signal: new AbortController().signal,
    })
    expect(first).toMatchObject({
      kind: "ready",
      read: {
        streams: [
          { records: [{ id: "repo-1" }], hasMore: true, cursor: "repo:2" },
        ],
      },
    })
    if (first.kind !== "ready") throw new Error("expected ready")

    const next = await dataSource.loadMore?.(first.read, {
      maxStreams: 24,
      maxRecords: 100,
      signal: new AbortController().signal,
    })
    expect(next).toMatchObject({
      kind: "ready",
      read: {
        streams: [
          {
            records: [{ id: "repo-1" }, { id: "repo-2" }],
            hasMore: false,
            cursor: null,
          },
        ],
      },
    })
    expect(tauriFetch.mock.calls.at(-1)?.[0]).toBe(
      "http://127.0.0.1:3100/v1/streams/repositories/records?limit=100&cursor=repo%3A2"
    )
  })

  it.each(["grant_revoked", "grant_expired"])(
    "returns to consent after %s and clears its in-memory capability",
    async code => {
      const dataSource = createProductionTimelineDataSource({
        port: 3100,
        devToken: "desktop-secret",
      })
      tauriFetch
        .mockImplementationOnce((_url, init) => localConsent(init, "request-2"))
        .mockResolvedValueOnce(
          response({ access_token: "pdpp-bearer-2", token_type: "Bearer" }, 201)
        )
        .mockResolvedValueOnce(
          response(
            {
              error: {
                code,
                message: "The grant is no longer valid",
              },
            },
            403
          )
        )
      const consent = await dataSource.requestConsent?.()
      await dataSource.approveConsent?.(consent!)
      await expect(
        dataSource.read({
          maxStreams: 24,
          maxRecords: 100,
          signal: new AbortController().signal,
        })
      ).resolves.toEqual({ kind: "unauthorized" })
      expect(getLocalTimelineCapability()).toBeNull()
    }
  )

  it("sends local revocation through the protected loopback endpoint", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    tauriFetch
      .mockImplementationOnce((_url, init) => localConsent(init, "request-3"))
      .mockResolvedValueOnce(
        response({ access_token: "pdpp-bearer-3", token_type: "Bearer" }, 201)
      )
      .mockResolvedValueOnce(response({ revoked: true }))
    const consent = await dataSource.requestConsent?.()
    await dataSource.approveConsent?.(consent!)
    await expect(
      revokeLocalTimelineConsent(3100, "desktop-secret")
    ).resolves.toBe(true)
    expect(tauriFetch.mock.calls[2][0]).toBe(
      "http://127.0.0.1:3100/v1/pdpp/local-timeline/revoke"
    )
    expect(tauriFetch.mock.calls[2][1].headers.Authorization).toBe(
      "Bearer desktop-secret"
    )
    expect(getLocalTimelineCapability()).toBeNull()
  })
})
