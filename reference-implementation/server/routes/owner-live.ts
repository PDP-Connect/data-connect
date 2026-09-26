// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner live-invalidation channel:
//
//   POST /_ref/owner-live/sessions      -> mint a short-lived attach token
//   GET  /_ref/owner-live/:token/events -> SSE: hello / invalidate / ping
//   GET  /v1/owner/live/revisions       -> the same map `hello` carries
//
// The channel says only "topic X changed, here is its revision". It never
// carries data; the console refetches the topic through its normal owner
// route. On every (re)connect `hello` sends all current revisions, so a
// client that missed events while disconnected catches up by comparing
// revisions. There is no replay log and no Last-Event-ID.
//
// Auth: both `/_ref` routes pass `requireOwnerSession`, the same gate as the
// run-interaction stream mint. The console's mint Server Action runs its own
// `requireDashboardAccess` first and forwards the owner cookie, like
// `mintRunInteractionStream`. `/v1/owner/live/revisions` takes the owner
// bearer (`requireToken` + `requireOwner`), like every other `/v1/owner/*`
// route.
//
// Pings are real `event: ping` messages, not `:` comments: ngrok drops
// comment-only SSE lines, so a comment keepalive never reaches the browser
// and cannot prove the channel is alive.

import { randomBytes } from "node:crypto"
import type { LiveRevisions } from "../live-revisions.ts"
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts"

export const LIVE_PING_INTERVAL_MS = 25_000
export const LIVE_TOKEN_TTL_MS = 60_000

interface RawResponse {
  end: () => void
  flushHeaders?: () => void
  setHeader: (name: string, value: string) => void
  statusCode: number
  write: (chunk: string) => boolean
}

interface RouteRequest {
  headers: { cookie?: string }
  params?: Record<string, string>
  raw?: { on: (event: "close", listener: () => void) => void }
}

interface RouteResponse {
  hijack?: () => void
  json: (body: unknown) => unknown
  raw?: RawResponse
  status: (code: number) => RouteResponse
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => unknown
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => unknown
}

type PdppError = (res: RouteResponse, status: number, code: string, message: string) => unknown

export interface MountOwnerLiveAsContext {
  isOwnerSessionActive: (req: RouteRequest) => Promise<boolean>
  live: LiveRevisions
  now?: () => number
  onSessionLogout: (req: RouteRequest, listener: () => void) => () => void
  pdppError: PdppError
  pingIntervalMs?: number
  requireOwnerSession: MiddlewareHandler
}

export function mountOwnerLiveAs(app: AppLike, ctx: MountOwnerLiveAsContext): void {
  const now = ctx.now ?? Date.now
  const pingIntervalMs = ctx.pingIntervalMs ?? LIVE_PING_INTERVAL_MS
  // token -> expiry. A token may attach more than once before it expires,
  // so EventSource's own quick retry works; after expiry the console mints
  // a new one.
  const tokens = new Map<string, number>()

  app.post("/_ref/owner-live/sessions", ctx.requireOwnerSession, (_req: RouteRequest, res: RouteResponse) => {
    const issuedAt = now()
    for (const [token, expiresAt] of tokens) {
      if (expiresAt <= issuedAt) tokens.delete(token)
    }
    const token = randomBytes(32).toString("base64url")
    const expiresAt = issuedAt + LIVE_TOKEN_TTL_MS
    tokens.set(token, expiresAt)
    return res.status(201).json({
      events_path: `/_ref/owner-live/${token}/events`,
      expires_at: new Date(expiresAt).toISOString(),
      object: "owner_live_session",
    })
  })

  app.get(
    "/_ref/owner-live/:token/events",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const token = req.params?.token ?? ""
      const expiresAt = tokens.get(token)
      if (expiresAt === undefined || expiresAt <= now()) {
        tokens.delete(token)
        ctx.pdppError(res, 401, "invalid_token", "Live channel token is unknown or expired")
        return
      }
      if (!(res.hijack && res.raw && req.raw)) {
        ctx.pdppError(res, 500, "api_error", "Transport does not support streaming responses")
        return
      }

      res.hijack()
      const raw = res.raw
      raw.statusCode = 200
      raw.setHeader("Content-Type", "text/event-stream")
      raw.setHeader("Cache-Control", "no-cache, no-transform")
      raw.setHeader("Connection", "keep-alive")
      raw.setHeader("X-Accel-Buffering", "no")
      raw.flushHeaders?.()

      let closed = false
      let pendingSend = Promise.resolve()
      const send = (name: string, data: unknown) => {
        // Preserve event order while the shared session store is consulted.
        // Local logout callbacks cannot observe revocation by another instance.
        pendingSend = pendingSend.then(async () => {
        if (closed) return
        try {
            const eventData = await data
            if (closed) return
            if (!(await ctx.isOwnerSessionActive(req))) {
              close()
              return
            }
            if (!closed) raw.write(`event: ${name}\ndata: ${JSON.stringify(eventData)}\n\n`)
        } catch {
            // Store failures must not leave an authenticated stream running.
            close()
        }
        })
        return pendingSend
      }

      // Subscribe before the snapshot so a change between the two is not lost.
      const unsubscribe = ctx.live.subscribe((topic, revision) => send("invalidate", { revision, topic }))
      const hello = send("hello", ctx.live.snapshot().then(revisions => ({ revisions })))
      let pingPending = false
      const ping = setInterval(() => {
        if (closed || pingPending) return
        pingPending = true
        void send("ping", {}).finally(() => { pingPending = false })
      }, pingIntervalMs)
      let stopWatchingLogout: () => void = () => undefined
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(ping)
        unsubscribe()
        stopWatchingLogout()
        try {
          raw.end()
        } catch {
          /* response already gone; subscriptions and timer are still removed */
        }
      }
      stopWatchingLogout = ctx.onSessionLogout(req, close)
      if (closed) stopWatchingLogout()
      req.raw.on("close", close)
      await hello
    }
  )
}

export interface MountOwnerLiveRsContext {
  live: LiveRevisions
  requireOwner: MiddlewareHandler
  requireToken: MiddlewareHandler
}

export function mountOwnerLiveRs(app: AppLike, ctx: MountOwnerLiveRsContext): void {
  app.get(
    "/v1/owner/live/revisions",
    ctx.requireToken,
    ctx.requireOwner,
    async (_req: RouteRequest, res: RouteResponse) =>
      res.json({ data: { revisions: await ctx.live.snapshot() }, object: "owner_live_revisions" })
  )
}
