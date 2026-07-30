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

  it("approves a bound local consent then reads streams and paginated records over PDPP", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    tauriFetch
      .mockImplementationOnce((_url, init) =>
        response({
          request_id: "request-1",
          session_id: JSON.parse(init.body).session_id,
          scopes: ["github.repositories"],
          authorization_details: {},
        })
      )
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

    await dataSource.requestConsent?.()
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

  it("follows opaque cursors without exceeding the global record bound", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    tauriFetch
      .mockImplementationOnce((_url, init) =>
        response({
          request_id: "request-pages",
          session_id: JSON.parse(init.body).session_id,
          scopes: [],
          authorization_details: {},
        })
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
    await dataSource.requestConsent?.()
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

  it("fails closed after revocation or expiry and loses its in-memory handoff on renderer restart", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    tauriFetch
      .mockImplementationOnce((_url, init) =>
        response({
          request_id: "request-2",
          session_id: JSON.parse(init.body).session_id,
          scopes: [],
          authorization_details: {},
        })
      )
      .mockResolvedValueOnce(
        response({ access_token: "pdpp-bearer-2", token_type: "Bearer" }, 201)
      )
      .mockResolvedValueOnce(
        response(
          {
            error: {
              code: "grant_revoked",
              message: "The grant has been revoked",
            },
          },
          403
        )
      )
    await dataSource.requestConsent?.()
    await expect(
      dataSource.read({
        maxStreams: 24,
        maxRecords: 100,
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ kind: "revoked" })

    clearLocalTimelineCapability()
    await expect(
      dataSource.read({
        maxStreams: 24,
        maxRecords: 100,
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ kind: "unauthorized" })
  })

  it("sends local revocation through the protected loopback endpoint", async () => {
    const dataSource = createProductionTimelineDataSource({
      port: 3100,
      devToken: "desktop-secret",
    })
    tauriFetch
      .mockImplementationOnce((_url, init) =>
        response({
          request_id: "request-3",
          session_id: JSON.parse(init.body).session_id,
          scopes: [],
          authorization_details: {},
        })
      )
      .mockResolvedValueOnce(
        response({ access_token: "pdpp-bearer-3", token_type: "Bearer" }, 201)
      )
      .mockResolvedValueOnce(response({ revoked: true }))
    await dataSource.requestConsent?.()
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
