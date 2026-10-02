// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-authenticated HTTP route for revealing the owner's own login
// password:
//
//   GET /v1/owner/credential/reveal   -> { data: { password: string } }
//
// Auth: owner bearer (`pdpp_token_kind: "owner"`), the SAME guard every other
// `/v1/owner/*` route uses (`requireToken` + `requireOwner`; see
// `owner-remote-access.ts`, `owner-recovery-key.ts`). No new auth scheme, and
// no new secret-exposure surface: a bearer that already passes this guard
// already has full owner control (every other `/v1/owner/*` mutation), so
// this route does not let a stolen session do anything it could not already
// do -- it just answers a question ("what is the owner password") that a
// stolen session's holder does not need answered.
//
// Why this route exists at all: the desktop app mints the owner password
// itself (32 random bytes, `src-tauri/src/owner_credential.rs`) and logs the
// owner in silently on the machine that generated it
// (`unified.rs::finish_bootstrap`) -- the owner never types it there. The
// ONLY place a human is ever asked to type this password is signing in from
// a SECOND device over the remote-access tunnel, and until this route
// existed there was no way for the owner to learn what to type: no reveal
// UI, no first-run display, no QR code, no export command anywhere in this
// codebase (verified by exhaustive grep before writing this route). See
// ai/research/product-design/auto-generated-owner-credentials-need-an-explicit-reveal-moment-not-just-mint-and-verify.md
// for the prior-art grounding (1Password's Secret Key is the closest
// analogue: generated on the user's behalf, required for new-device sign-in,
// and deliberately revealable on demand from an already-authenticated
// session -- never hidden after initial generation).
//
// Unlike `owner-recovery-key.ts`, this is NOT a relay to a Rust-side file
// watcher: the reference server already holds the plaintext password in
// memory (it is the value `passwordMatches` in `owner-auth.ts` compares
// every login attempt against), so this route reads it directly with no
// round trip. This route MUST NEVER log the password -- `readOwnerPassword`
// is called once per request and returned straight to the response body.
//
// Setting or changing the owner password is deliberately out of scope here,
// for the same reason `owner-remote-access.ts` gives for not exposing
// credential writes over HTTP: it is a one-time, native OS-keychain write
// (`owner_credential.rs::save_owner_credential`), and there is no
// HTTP-reachable equivalent that isn't a strictly weaker, unencrypted secret
// store. This route only ever reads the value the process was already
// started with.

import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts"

interface RouteRequest {
  readonly body?: unknown
  readonly headers?: Record<string, string | string[] | undefined>
}

interface RouteResponse {
  json: (body: unknown) => unknown
  status: (code: number) => RouteResponse
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike
}

export interface MountOwnerCredentialRevealContext {
  handleError: (res: unknown, err: unknown) => void
  isEligibleForReveal: (req: RouteRequest) => boolean
  /**
   * Reads the owner password this process was started with, or `null` when
   * owner auth is disabled (no password configured). Never mints or
   * mutates a credential -- a pure accessor over the value already held in
   * memory for login comparison.
   */
  readOwnerPassword: () => string | null
  requireOwner: MiddlewareHandler
  requireToken: MiddlewareHandler
}

const OWNER_AUTH_DISABLED_MESSAGE = "Owner auth is not enabled on this deployment; there is no password to reveal."
const OWNER_CREDENTIAL_REVEAL_UNAVAILABLE_MESSAGE = "Owner credential reveal is not available on this deployment."
const LOCAL_REVEAL_PROOF_HEADER = "x-pdpp-local-owner-credential-reveal-proof"

export function localOwnerCredentialRevealProofHeader(proof: string): Record<string, string> {
  return { [LOCAL_REVEAL_PROOF_HEADER]: proof }
}

export function hasLocalOwnerCredentialRevealProof(req: RouteRequest, proof: string | null): boolean {
  if (!proof) {
    return false
  }
  const header = req.headers?.[LOCAL_REVEAL_PROOF_HEADER]
  return Array.isArray(header) ? header.includes(proof) : header === proof
}

export function mountOwnerCredentialReveal(app: AppLike, ctx: MountOwnerCredentialRevealContext): void {
  const guarded = [ctx.requireToken, ctx.requireOwner] as const

  app.get("/v1/owner/credential/reveal", ...guarded, (req: RouteRequest, res: RouteResponse) => {
    try {
      if (!ctx.isEligibleForReveal(req)) {
        res.status(404).json({
          error: {
            code: "owner_credential_reveal_unavailable",
            message: OWNER_CREDENTIAL_REVEAL_UNAVAILABLE_MESSAGE,
            type: "invalid_request",
          },
        })
        return
      }
      const password = ctx.readOwnerPassword()
      if (password === null) {
        res.status(404).json({
          error: { code: "owner_auth_disabled", message: OWNER_AUTH_DISABLED_MESSAGE, type: "invalid_request" },
        })
        return
      }
      res.json({ data: { password }, object: "owner_credential_reveal" })
    } catch (err) {
      ctx.handleError(res, err)
    }
  })
}
