// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-authenticated HTTP routes for the generic desktop app-config blob:
//
//   GET  /v1/owner/app-config    -> current AppConfig
//   POST /v1/owner/app-config    -> validate shape + persist a new AppConfig
//
// Auth: owner bearer (`pdpp_token_kind: "owner"`), the same guard every other
// `/v1/owner/*` route uses (`requireToken` + `requireOwner`; see
// `owner-remote-access.ts`, `owner-connector-install.ts`). No new auth scheme.
//
// Why this route exists at all: Tauri never injects its `invoke()` bridge
// into the console's `http://127.0.0.1:{port}` window (Tauri Discussion
// #2650), so the `get_app_config`/`set_app_config` Tauri commands
// (`src-tauri/src/commands/file_ops.rs`) are unreachable from the console
// window no matter how they are declared. This mirrors the
// `owner-remote-access.ts` precedent for the same reason.
//
// Unlike remote-access.json this config file has no OS side effect on
// write -- it is plain JSON -- so, unlike autostart, this route can persist
// it directly with no Rust-side polling loop involved.
//
// The console already does the "load current config, spread in the changed
// field, save" merge itself (`toggleStartMinimized`/`toggleCloseToTray` in
// `desktop-settings-setting.tsx`), so this route does not deep-merge on the
// server: it validates shape and overwrites, matching how `set_app_config`
// on the Rust side behaves (a full overwrite of config.json).

import type { AppConfig, AppConfigStore } from "../app-config-store.ts"
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

export interface MountOwnerAppConfigContext {
  handleError: (res: unknown, err: unknown) => void
  pdppError: (res: RouteResponse, status: number, code: string, message: string, param?: string | null) => void
  requireOwner: MiddlewareHandler
  requireToken: MiddlewareHandler
  store: AppConfigStore
}

function isAppConfigShaped(value: unknown): value is AppConfig {
  if (!value || typeof value !== "object") {
    return false
  }
  const candidate = value as Partial<AppConfig>
  return (
    (candidate.storageProvider === null || typeof candidate.storageProvider === "string") &&
    (candidate.serverMode === null || typeof candidate.serverMode === "string") &&
    (candidate.selfHostedUrl === null || typeof candidate.selfHostedUrl === "string") &&
    typeof candidate.startMinimized === "boolean" &&
    typeof candidate.closeToTray === "boolean"
  )
}

export function mountOwnerAppConfig(app: AppLike, ctx: MountOwnerAppConfigContext): void {
  const guarded = [ctx.requireToken, ctx.requireOwner] as const

  app.get(
    "/v1/owner/app-config",
    ...guarded,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        res.json({ data: await ctx.store.load(), object: "app_config" })
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
        if (!isAppConfigShaped(req.body)) {
          ctx.pdppError(res, 400, "invalid_request", "body must be an AppConfig", null)
          return
        }
        const saved = await ctx.store.save(req.body)
        res.json({ data: saved, object: "app_config" })
      } catch (err) {
        ctx.handleError(res, err)
      }
    }
  )
}
