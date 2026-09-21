// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-authenticated HTTP route that opens a URL in the OWNER'S system
// browser, replacing the console's dead `@tauri-apps/plugin-shell` `open()`
// call:
//
//   POST /v1/owner/open-external-url    -> enqueue a URL to be opened
//
// Auth: owner bearer (`pdpp_token_kind: "owner"`), the SAME guard every
// other `/v1/owner/*` route uses (`requireToken` + `requireOwner`; see
// `owner-remote-access.ts`, `owner-autostart.ts`). No new auth scheme.
//
// Why this route exists at all: Tauri never injects its `invoke()` bridge
// into the console's `http://127.0.0.1:{port}` window (Tauri Discussion
// #2650) -- no capability/ACL configuration changes that (PR #186 granted
// `shell:allow-open` in `src-tauri/capabilities/console.json` and it did
// NOT work: `window.__TAURI__` and `invoke()` are simply absent in that
// window, verified against the merged build). `OpenExternalLink`
// (`apps/console/src/app/(console)/components/open-external-link.tsx`)
// previously tried to import `@tauri-apps/plugin-shell` and call `open()`
// directly from the console window -- unreachable for the same reason
// `get_autostart_enabled`/`configure_remote_access` were. This route moves
// the action to plain authenticated HTTP the console already talks to for
// everything else, mirroring the autostart/remote-access precedent.
//
// SECURITY -- this is a bridge from web content to a native OS action
// (spawning a process via `open::that_detached` on the Rust side), reachable
// from the console origin, and the console is reachable over the owner's
// PUBLIC ngrok/Cloudflare tunnel when remote access is on
// (`remote-access-config.ts`). A remote attacker who obtains a session must
// not be able to make the owner's desktop open arbitrary things:
//
//   - Owner-authenticated: same `requireToken` + `requireOwner` gate as
//     every other `/v1/owner/*` route. A non-owner session (a grant-flow
//     visitor, a connector's own scoped token) cannot reach this at all.
//   - Scheme allowlist, enforced HERE before the request is ever written to
//     disk (defense in depth -- `open_external_url.rs::
//     validate_external_url` re-checks on the Rust side too, since a queue
//     file is a process boundary and nothing that crosses one is trusted
//     twice from the same check). Only `https:` is allowed. `http:` is
//     deliberately excluded: admitting it would let a request target
//     loopback services (this very server's own `http://127.0.0.1:{port}`,
//     or anything else listening on localhost) via the OS opener, and every
//     current external link in the console is already `https:` -- there is
//     no call site that needs `http:`. `file:`, `javascript:`, `data:`, and
//     any other scheme are rejected outright.
//   - No shell/command execution anywhere in this path: the body is a
//     single URL string, never interpolated into a command line. Rust's
//     `open::that_detached` hands the URL to the OS's own "open with
//     default handler" facility (`xdg-open`/`open`/`start`), the same
//     primitive the tray's "Open console in browser" action already uses
//     (`unified.rs::handle_tray_menu_event`) -- there is no argument or flag
//     injection surface because the OS opener does not interpret the string
//     as a shell command.
//
// Persistence: `OpenExternalUrlStore` (`../open-external-url-store.ts`)
// appends to `open-external-url-queue.json` under `PDPP_DATA_DIR`. Unlike
// autostart, this route does not poll for an ack -- see
// `open-external-url-store.ts`'s module doc for why enqueueing is enough.

import type { OpenExternalUrlStore } from "../open-external-url-store.ts"
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts"

interface RouteRequest {
  readonly body?: unknown
}

interface RouteResponse {
  json: (body: unknown) => unknown
  status: (code: number) => RouteResponse
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>

interface AppLike {
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike
}

export interface MountOwnerOpenExternalUrlContext {
  handleError: (res: unknown, err: unknown) => void
  pdppError: (res: RouteResponse, status: number, code: string, message: string, param?: string | null) => void
  requireOwner: MiddlewareHandler
  requireToken: MiddlewareHandler
  store: OpenExternalUrlStore
}

// Only `https:` may reach the OS opener. See the security note above for
// why `http:` is excluded even though it would be a smaller change.
const ALLOWED_SCHEMES = new Set(["https:"])

export function validateExternalUrl(candidate: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return { ok: false, reason: "url must be a non-empty string" }
  }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, reason: "url must be a valid absolute URL" }
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: `url scheme "${parsed.protocol}" is not allowed; only https: may be opened` }
  }
  return { ok: true, url: parsed.toString() }
}

export function mountOwnerOpenExternalUrl(app: AppLike, ctx: MountOwnerOpenExternalUrlContext): void {
  const guarded = [ctx.requireToken, ctx.requireOwner] as const

  app.post(
    "/v1/owner/open-external-url",
    ...guarded,
    async (req: RouteRequest, res: RouteResponse) => {
      const body = req.body as Partial<{ url: unknown }> | undefined
      const validated = validateExternalUrl(body?.url)
      if (!validated.ok) {
        ctx.pdppError(res, 400, "invalid_request", validated.reason, "url")
        return
      }
      try {
        const request = await ctx.store.enqueue(validated.url)
        res.json({ data: { id: request.id, url: request.url }, object: "open_external_url_request" })
      } catch (err) {
        ctx.handleError(res, err)
      }
    }
  )
}
