// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-authenticated HTTP routes for desktop app preferences:
//
//   GET  /v1/owner/app-config    -> current AppConfig plus revision
//   POST /v1/owner/app-config    -> If-Match field patch, or 409 conflict
//
// Auth: owner bearer (`pdpp_token_kind: "owner"`), the same guard every other
// `/v1/owner/*` route uses (`requireToken` + `requireOwner`; see
// `owner-remote-access.ts`, `owner-connector-install.ts`). No new auth scheme.
//
// Why this route exists at all: Tauri never injects its `invoke()` bridge
// into the console's `http://127.0.0.1:{port}` window (Tauri Discussion
// #2650), so the `get_app_config` Tauri command
// (`src-tauri/src/commands/file_ops.rs`) is unreachable from the console
// window no matter how they are declared. This mirrors the
// `owner-remote-access.ts` precedent for the same reason.
//
// Unlike remote-access.json this config file has no OS side effect on
// write -- it is plain JSON -- so, unlike autostart, this route can persist
// it directly with no Rust-side polling loop involved.
//
// The reference server is the config writer. The route applies a validated
// field patch against the revision returned by GET, so two windows cannot
// silently overwrite each other's unrelated settings.

import { AppConfigConflict, type AppConfigPatch, type AppConfigStore } from "../app-config-store.ts"
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts"

interface RouteRequest {
  readonly body?: unknown
  readonly headers?: Record<string, string | undefined>
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

export interface MountOwnerAppConfigContext {
  handleError: (res: unknown, err: unknown) => void
  pdppError: (res: RouteResponse, status: number, code: string, message: string, param?: string | null) => void
  requireOwner: MiddlewareHandler
  requireToken: MiddlewareHandler
  store: AppConfigStore
}

export function mountOwnerAppConfig(app: AppLike, ctx: MountOwnerAppConfigContext): void {
  const guarded = [ctx.requireToken, ctx.requireOwner] as const

  app.get(
    "/v1/owner/app-config",
    ...guarded,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        const current = await ctx.store.loadEnvelope()
        res.json({ data: current.config, revision: current.revision, object: "app_config" })
      } catch (err) {
        ctx.handleError(res, err)
      }
    }
  )

  app.post(
    "/v1/owner/app-config",
    ...guarded,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const revision = req.headers?.["if-match"]
        if (!revision) {
          ctx.pdppError(res, 428, "precondition_required", "If-Match revision is required", null)
          return
        }
        const saved = await ctx.store.patchField(req.body as AppConfigPatch, revision)
        res.json({ data: saved.config, revision: saved.revision, object: "app_config" })
      } catch (err) {
        if (err instanceof AppConfigConflict) {
          res.status(409).json({ error: { code: "app_config_conflict", message: err.message },
            data: err.current.config, revision: err.current.revision })
          return
        }
        if (err instanceof Error && err.message.startsWith("Invalid app configuration patch")) {
          ctx.pdppError(res, 400, "invalid_request", err.message, null)
          return
        }
        ctx.handleError(res, err)
      }
    }
  )
}
