// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-authenticated HTTP routes for the remote-access providers:
//
//   GET  /v1/owner/remote-access/config                      -> current RemoteAccessConfig
//   POST /v1/owner/remote-access/config                      -> validate + persist a new config
//   GET  /v1/owner/remote-access/inspect                     -> user_supplied_origin availability probe
//   GET  /v1/owner/remote-access/inspect/ngrok               -> ngrok availability probe
//   GET  /v1/owner/remote-access/inspect/cloudflare_tunnel   -> Cloudflare named-tunnel availability probe
//
// Auth: owner bearer (`pdpp_token_kind: "owner"`), the SAME guard every other
// `/v1/owner/*` route uses (`requireToken` + `requireOwner`; see
// `owner-connector-install.ts`, `owner-control.ts`). No new auth scheme.
//
// Why these routes exist at all: Tauri never injects its `invoke()` bridge
// into the console's `http://127.0.0.1:{port}` window, by design (Tauri
// Discussion #2650) -- no capability/ACL configuration changes that. The
// remote-access Tauri commands the console used to call directly
// (`src-tauri/src/remote_access.rs`) are therefore unreachable from the
// console window no matter how they are declared. Plain authenticated HTTP on
// the server the console already talks to for everything else works
// identically whether the console runs inside Tauri or in a self-hoster's
// plain browser.
//
// ngrok's credential handoff: ngrok genuinely needs native code for two
// things -- an OS keychain slot for its authtoken and Rust-side supervision
// of an embedded tunnel session (`src-tauri/src/remote_access_ngrok.rs`) --
// and that native work is NOT moved here. What moves is only the submission
// path: this route accepts the plaintext authtoken over the owner-
// authenticated HTTP body (`providerCredential`), seals it with
// `createCredentialCipherFromEnv()` under `PDPP_CREDENTIAL_ENCRYPTION_KEY` --
// the SAME key `src-tauri/src/owner_credential.rs` generates and already
// hands this process -- and stores the sealed blob as
// `ngrok_authtoken_sealed` in the persisted config. The Tauri supervisor's
// existing config-file watcher (`spawn_remote_access_config_watcher` in
// `unified.rs`) decrypts it with the key it already holds, moves the
// plaintext into the OS keychain via `store_provider_credential_reference`,
// and blanks the sealed field back to null before restarting the stack and
// starting the ngrok tunnel. The sealed token is therefore never at rest as
// plaintext, and the route never returns it (sealed or not) in a response.
//
// A deployment with no Tauri supervisor (a plain self-hosted RI, or the
// console reached from a browser pointed at one) can still submit an ngrok
// config through this route -- validation and sealing do not require a
// native host -- but nothing will ever consume `ngrok_authtoken_sealed` or
// start a tunnel without the watcher running. `GET
// /v1/owner/remote-access/inspect/ngrok` (`inspectNgrok` in
// `../remote-access-config.ts`) reports this honestly via
// `PDPP_MANAGED_DESKTOP_HOST`, an env var only the Tauri supervisor sets
// (`src-tauri/src/unified.rs::ri_environment`), so the console can tell the
// owner precisely why ngrok cannot be enabled here instead of accepting a
// config that will never activate.
//
// Setting the owner password for the FIRST time is out of scope here: it is a
// one-time write to the OS keychain (`owner_credential.rs::
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

import { createCredentialCipherFromEnv } from "../stores/credential-encryption.ts"
import {
  inspectCloudflareTunnel,
  inspectNgrok,
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

/** The POST body: a `RemoteAccessConfig` plus ngrok's plaintext authtoken,
 * present only on the wire for exactly this request -- the handler seals it
 * before anything is persisted (see `mountOwnerRemoteAccess`'s POST handler).
 */
interface RemoteAccessConfigRequestBody extends RemoteAccessConfig {
  providerCredential?: string
}

function isRemoteAccessConfigShaped(value: unknown): value is RemoteAccessConfigRequestBody {
  if (!value || typeof value !== "object") {
    return false
  }
  const candidate = value as Partial<RemoteAccessConfigRequestBody>
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
        const { providerCredential, ...config } = req.body
        let toSave: RemoteAccessConfig = config
        if (config.provider === "ngrok") {
          if (!providerCredential || !providerCredential.trim()) {
            ctx.pdppError(res, 400, "remote_access_config_invalid", "ngrok requires providerCredential (the authtoken).", null)
            return
          }
          const cipher = createCredentialCipherFromEnv()
          toSave = { ...config, ngrok_authtoken_sealed: cipher.seal(providerCredential.trim()) }
        }
        if (config.provider === "cloudflare_tunnel") {
          // Checked before the credential, matching the order the console's
          // own submit guard uses (remote-access-setting.tsx): a missing
          // binary is the more fundamental problem. Only an exact `false`
          // (a real, checked "not installed") rejects -- `null` ("unknown",
          // e.g. no managed desktop host) must never be misread as "missing"
          // and block a submission the owner has no way to explain, the same
          // tri-state policy the console UI already enforces client-side.
          // This route is the one path that actually persists the config;
          // the console's own check is real but bypassable (a stale page, a
          // direct API call, a compromised session token) and was the only
          // enforcement before this, which let a config with no binary
          // present be saved successfully -- the exact "commit before you
          // fail" bug this provider's UI exists to prevent, just reachable
          // by skipping the button instead of using it.
          if (inspectCloudflareTunnel().cloudflared_binary_present === false) {
            ctx.pdppError(
              res,
              400,
              "remote_access_config_invalid",
              "cloudflared is not installed on this machine yet. Install it, then try again.",
              null
            )
            return
          }
          if (!providerCredential || !providerCredential.trim()) {
            ctx.pdppError(res, 400, "remote_access_config_invalid", "cloudflare_tunnel requires providerCredential (the tunnel token).", null)
            return
          }
          const cipher = createCredentialCipherFromEnv()
          toSave = { ...config, cloudflare_tunnel_token_sealed: cipher.seal(providerCredential.trim()) }
        }
        const saved = await ctx.store.save(toSave);
        // Never echo the sealed (or plaintext) credential back to the console.
        const { ngrok_authtoken_sealed: _sealed, cloudflare_tunnel_token_sealed: _cfSealed, ...safeSaved } = saved
        res.json({ data: safeSaved, object: "remote_access_config" })
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

  app.get(
    "/v1/owner/remote-access/inspect/ngrok",
    ...guarded,
    (_req: RouteRequest, res: RouteResponse) => {
      res.json({ data: inspectNgrok(), object: "remote_access_inspection" })
    }
  )

  app.get(
    "/v1/owner/remote-access/inspect/cloudflare_tunnel",
    ...guarded,
    (_req: RouteRequest, res: RouteResponse) => {
      res.json({ data: inspectCloudflareTunnel(), object: "remote_access_inspection" })
    }
  )
}
