// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-authenticated HTTP route for exporting the desktop database
// encryption key as a printable recovery code:
//
//   POST /v1/owner/recovery-key/export   -> { data: { code: string } }
//
// Auth: owner bearer (`pdpp_token_kind: "owner"`), the SAME guard every other
// `/v1/owner/*` route uses (`requireToken` + `requireOwner`; see
// `owner-remote-access.ts`, `owner-control.ts`). No new auth scheme, and no
// new secret-exposure surface: the owner is already authenticated by the time
// they reach Settings, over the same HTTPS-to-loopback channel every other
// owner route already carries session material on.
//
// Why this route exists at all (see local/HOST-BRIDGE-DESIGN-0918.md): the
// console window is `WebviewUrl::External` and never gets Tauri's `invoke()`
// bridge, so `export_database_encryption_recovery_code`
// (`src-tauri/src/commands/recovery_key.rs`) is unreachable directly from
// Settings. Unlike `owner-remote-access.ts`'s provider config, though, RS has
// no independent way to compute this value -- the recovery code is derived
// from the Rust process's OS-keychain-backed database key, which only Rust
// can read. This route is therefore a pure relay: `RecoveryKeyStore`
// (`../recovery-key-store.ts`) writes a private command under `PDPP_DATA_DIR`,
// the Tauri watcher answers with a short-lived result, and this route returns
// the code after the store consumes that result.
//
// This route MUST NEVER log the code. `handleError`/`pdppError` on the
// failure path only ever see the store's error MESSAGE (e.g. "no vault
// exists yet" or a timeout), never the code -- `RecoveryKeyStore.requestExport`
// only resolves with the code on its happy path, which this handler returns
// directly to the response body and nowhere else.

import type { RecoveryKeyStore } from "../recovery-key-store.ts"
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

export interface MountOwnerRecoveryKeyContext {
  handleError: (res: unknown, err: unknown) => void
  requireOwner: MiddlewareHandler
  requireToken: MiddlewareHandler
  store: RecoveryKeyStore
}

export function mountOwnerRecoveryKey(app: AppLike, ctx: MountOwnerRecoveryKeyContext): void {
  const guarded = [ctx.requireToken, ctx.requireOwner] as const

  app.post(
    "/v1/owner/recovery-key/export",
    ...guarded,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        const code = await ctx.store.requestExport()
        res.json({ data: { code }, object: "recovery_key_export" })
      } catch (err) {
        ctx.handleError(res, err)
      }
    }
  )
}
