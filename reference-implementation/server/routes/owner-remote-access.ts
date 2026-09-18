// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-authenticated HTTP routes for the `user_supplied_origin` remote-access
// provider:
//
//   GET  /v1/owner/remote-access/config    -> current RemoteAccessConfig
//   POST /v1/owner/remote-access/config    -> validate + persist a new config
//   GET  /v1/owner/remote-access/inspect   -> availability/authentication probe
//
// Auth: owner bearer (`pdpp_token_kind: "owner"`), the SAME guard every other
// `/v1/owner/*` route uses (`requireToken` + `requireOwner`; see
// `owner-connector-install.ts`, `owner-control.ts`). No new auth scheme.
//
// Why these routes exist at all (see local/HOST-BRIDGE-DESIGN-0918.md and
// local/DEPLOYMENT-MODE-DESIGN-0918.md): Tauri never injects its `invoke()`
// bridge into the console's `http://127.0.0.1:{port}` window, by design
// (Tauri Discussion #2650) -- no capability/ACL configuration changes that.
// The four remote-access Tauri commands the console called
// (`get_remote_access_config` / `set_remote_access_config` /
// `configure_remote_access` / `inspect_remote_access`, all in
// `src-tauri/src/remote_access.rs`) are therefore unreachable from the console
// window no matter how they are declared. Plain authenticated HTTP on the
// server the console already talks to for everything else works identically
// whether the console runs inside Tauri or in a self-hoster's plain browser.
//
// SCOPE FENCE: this file owns ONLY the `user_supplied_origin` provider, which
// has no native dependency (no OS keychain, no supervised child process) and
// so can run fully over HTTP. ngrok needs the OS keychain for its authtoken
// and Rust-side supervision of an embedded tunnel session -- both genuinely
// native -- and stays reachable only through the existing Tauri commands.
// `posture: "public_url"` with `provider: "ngrok"` is therefore rejected here
// (see `validateRemoteAccessConfig`); the desktop app keeps offering it via
// `configure_remote_access`.
//
// Setting the owner password for the FIRST time is also out of scope here: it
// is a one-time write to the OS keychain (`owner_credential.rs::
// save_owner_credential`), which is exactly as native as ngrok's authtoken
// storage and for the same reason (there is no HTTP-reachable equivalent that
// isn't a strictly weaker, unencrypted secret store). These routes require an
// owner bearer token, which cannot be minted without `PDPP_OWNER_PASSWORD`
// already being configured -- the same owner-password gate the desktop
// onboarding flow establishes, and the same gate `owner-exposure-posture.ts`
// already enforces at boot for any non-loopback deployment. A self-hoster sets
// `PDPP_OWNER_PASSWORD` as an operator env var, same as every other owner
// control already requires.
//
// Persistence: `RemoteAccessConfigStore` (`../remote-access-store.ts`) writes
// `remote-access.json` under `PDPP_DATA_DIR`. In the managed desktop stack
// that is the SAME file `src-tauri/src/remote_access.rs` reads to build the
// sidecar's environment at each (re)start -- one persisted config, not a
// parallel one. Applying a changed posture still requires a process restart
// (the four PDPP_* reachability fields are parsed once at server startup;
// see `reachability-contract.ts`), exactly as it did before this change. The
// desktop app now polls the shared config file and restarts the managed stack
// automatically when it changes underneath it (see `unified.rs`'s
// `spawn_remote_access_config_watcher`); a plain self-hosted deployment
// applies a change the same way it applies any other reachability change --
// restart the process.

import {
  inspectUserSuppliedOrigin,
  type RemoteAccessConfig,
} from "../remote-access-config.ts"
import type { RemoteAccessConfigStore } from "../remote-access-store.ts"
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

export interface MountOwnerRemoteAccessContext {
  handleError: (res: unknown, err: unknown) => void
  pdppError: (res: RouteResponse, status: number, code: string, message: string, param?: string | null) => void
  requireOwner: MiddlewareHandler
  requireToken: MiddlewareHandler
  store: RemoteAccessConfigStore
}

function isRemoteAccessConfigShaped(value: unknown): value is RemoteAccessConfig {
  if (!value || typeof value !== "object") {
    return false
  }
  const candidate = value as Partial<RemoteAccessConfig>
  return (
    (candidate.posture === "off" || candidate.posture === "my_devices_only" || candidate.posture === "public_url") &&
    typeof candidate.fields === "object" &&
    candidate.fields !== null
  )
}

export function mountOwnerRemoteAccess(app: AppLike, ctx: MountOwnerRemoteAccessContext): void {
  const guarded = [ctx.requireToken, ctx.requireOwner] as const

  app.get(
    "/v1/owner/remote-access/config",
    ...guarded,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        res.json({ data: await ctx.store.load(), object: "remote_access_config" })
      } catch (err) {
        ctx.handleError(res, err)
      }
    }
  )

  app.post(
    "/v1/owner/remote-access/config",
    ...guarded,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        if (!isRemoteAccessConfigShaped(req.body)) {
          ctx.pdppError(res, 400, "invalid_request", "body must be a RemoteAccessConfig", null)
          return
        }
        const saved = await ctx.store.save(req.body);
        res.json({ data: saved, object: "remote_access_config" })
      } catch (err) {
        if (err instanceof Error) {
          ctx.pdppError(res, 400, "remote_access_config_invalid", err.message, null)
          return
        }
        ctx.handleError(res, err)
      }
    }
  )

  app.get(
    "/v1/owner/remote-access/inspect",
    ...guarded,
    (_req: RouteRequest, res: RouteResponse) => {
      res.json({ data: inspectUserSuppliedOrigin(), object: "remote_access_inspection" })
    }
  )
}
