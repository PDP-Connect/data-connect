// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-authenticated HTTP routes for the launch-at-login setting:
//
//   GET  /v1/owner/autostart    -> current autostart state
//   POST /v1/owner/autostart    -> request a change, wait for the desktop
//                                  app to apply it, return the result
//
// Auth: owner bearer (`pdpp_token_kind: "owner"`), the same guard every other
// `/v1/owner/*` route uses (`requireToken` + `requireOwner`; see
// `owner-remote-access.ts`).
//
// Why this route exists at all: same injection gap as `owner-remote-access.ts`
// and `owner-app-config.ts` -- Tauri never injects `invoke()` into the
// console's `http://127.0.0.1:{port}` window. Autostart is different from
// app-config, though: it is an imperative OS action
// (`tauri_plugin_autostart`) that only the Tauri/Rust process can perform, so
// this route does not persist the setting itself -- it hands the request to
// `AutostartStore` (`../autostart-store.ts`), which writes a request into
// `autostart.json` and polls for `src-tauri/src/unified.rs::
// spawn_autostart_watcher` to apply it and write back the result.

import type { AutostartState, AutostartStore } from "../autostart-store.ts"
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
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike
}

export interface MountOwnerAutostartContext {
  handleError: (res: unknown, err: unknown) => void
  pdppError: (res: RouteResponse, status: number, code: string, message: string, param?: string | null) => void
  requireOwner: MiddlewareHandler
  requireToken: MiddlewareHandler
  store: AutostartStore
}

// Project only `enabled`/`error`/`pending` out of the full internal state --
// `requestId`/`appliedRequestId` are request bookkeeping this server
// shouldn't leak. `pending` is true while a requested change has not been
// applied yet, so another tab can say "Applying…" instead of painting the
// desired value as fact.
function toResponseShape(state: AutostartState): { enabled: boolean; error: string | null; pending: boolean } {
  return { enabled: state.enabled, error: state.error, pending: state.appliedRequestId < state.requestId }
}

export function mountOwnerAutostart(app: AppLike, ctx: MountOwnerAutostartContext): void {
  const guarded = [ctx.requireToken, ctx.requireOwner] as const

  app.get(
    "/v1/owner/autostart",
    ...guarded,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        res.json({ data: toResponseShape(await ctx.store.load()), object: "autostart_state" })
      } catch (err) {
        ctx.handleError(res, err)
      }
    }
  )

  app.post(
    "/v1/owner/autostart",
    ...guarded,
    async (req: RouteRequest, res: RouteResponse) => {
      const body = req.body as Partial<{ enabled: unknown }> | undefined
      if (!body || typeof body.enabled !== "boolean") {
        ctx.pdppError(res, 400, "invalid_request", "body must be { enabled: boolean }", "enabled")
        return
      }
      try {
        const state = await ctx.store.requestChange(body.enabled)
        res.json({ data: toResponseShape(state), object: "autostart_state" })
      } catch (err) {
        if (err instanceof Error) {
          ctx.pdppError(res, 409, "autostart_not_applied", err.message, null)
          return
        }
        ctx.handleError(res, err)
      }
    }
  )
}
