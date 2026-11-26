// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Asks "is this the owner password?" outside the sign-in form, for routes that
// re-ask before a sensitive reveal (the recovery code). It uses the same
// verifier (`verifyOwnerPassword`) and the same attempt throttle
// (`createOwnerLoginRateLimiter`) as sign-in in `owner-auth.ts`, and holds no
// session state. The plaintext password is compared and dropped; it is never
// stored or logged here.

import crypto from "node:crypto"

import {
  createOwnerLoginRateLimiter,
  type OwnerLoginRateLimitConfig,
  type OwnerLoginRateLimitRequest,
} from "./owner-login-rate-limit.ts"
import { type OwnerPasswordVerifier, verifyOwnerPassword } from "./owner-password-verifier.ts"

export type OwnerPasswordCheckResult =
  | { status: "ok" }
  | { status: "invalid" }
  | { status: "rate_limited"; retryAfterSeconds: number }

export interface OwnerPasswordCheck {
  /** Throttled like sign-in: every call counts as one attempt, then the password is compared. */
  check: (req: OwnerLoginRateLimitRequest, submitted: string) => Promise<OwnerPasswordCheckResult>
  /** False when this install has no owner password at all. */
  isSet: () => Promise<boolean>
}

export interface OwnerPasswordCheckOptions {
  /** Same shape sign-in takes; `false` turns the throttle off (test fixtures only). */
  loginRateLimit: OwnerLoginRateLimitConfig | false
  /** A password supplied by environment or desktop, compared directly as sign-in does. */
  password?: string | null
  /** Where the app-managed verifier lives; read on every call so a password change takes effect. */
  store?: { readVerifier: () => Promise<OwnerPasswordVerifier | null> } | null
  /** A verifier supplied at startup, used when the store holds none. */
  verifier?: OwnerPasswordVerifier | null
}

function sameString(a: string, b: string): boolean {
  const left = crypto.createHash("sha256").update(a).digest()
  const right = crypto.createHash("sha256").update(b).digest()
  return crypto.timingSafeEqual(left, right)
}

export function createOwnerPasswordCheck({
  loginRateLimit,
  password = null,
  store = null,
  verifier = null,
}: OwnerPasswordCheckOptions): OwnerPasswordCheck {
  const limiter =
    loginRateLimit === false
      ? { check: () => null, recordSuccess: () => undefined }
      : createOwnerLoginRateLimiter(loginRateLimit)

  async function activeVerifier(): Promise<OwnerPasswordVerifier | null> {
    return (await store?.readVerifier()) ?? verifier
  }

  return {
    async check(req, submitted) {
      const retryAfterSeconds = limiter.check(req)
      if (retryAfterSeconds !== null) {
        return { retryAfterSeconds, status: "rate_limited" }
      }
      let matched = false
      if (password) {
        matched = sameString(submitted, password)
      } else {
        const stored = await activeVerifier()
        matched = stored ? await verifyOwnerPassword(submitted, stored) : false
      }
      if (!matched) {
        return { status: "invalid" }
      }
      limiter.recordSuccess(req)
      return { status: "ok" }
    },
    async isSet() {
      return Boolean(password) || (await activeVerifier()) !== null
    },
  }
}

export interface OwnerPasswordGateResponse {
  json: (body: unknown) => unknown
  setHeader?: (name: string, value: string) => unknown
  status: (code: number) => OwnerPasswordGateResponse
}

/**
 * Re-asks for the owner password before a sensitive export (no time window).
 * Order: no password on this install, then none sent (spends no attempt), then
 * the throttled comparison. Returns true only when the caller may go on; on
 * false it has already written the refusal.
 */
export async function passOwnerPasswordGate(
  check: OwnerPasswordCheck,
  req: { readonly body?: unknown; readonly headers?: OwnerLoginRateLimitRequest["headers"] },
  res: OwnerPasswordGateResponse
): Promise<boolean> {
  if (!(await check.isSet())) {
    res.status(409).json({
      error: { code: "owner_password_not_set", message: "Set an owner password before showing the recovery code." },
    })
    return false
  }
  const body = req.body
  const submitted =
    body && typeof body === "object" && typeof (body as { password?: unknown }).password === "string"
      ? (body as { password: string }).password
      : ""
  if (submitted === "") {
    res.status(401).json({
      error: { code: "owner_password_required", message: "Send the owner password in the request body." },
    })
    return false
  }
  const result = await check.check({ headers: {}, ...req } as OwnerLoginRateLimitRequest, submitted)
  if (result.status === "rate_limited") {
    res.setHeader?.("Retry-After", String(result.retryAfterSeconds))
    res.status(429).json({
      error: {
        code: "owner_login_rate_limited",
        message: "Too many attempts. Retry after the indicated delay.",
        type: "slow_down",
      },
    })
    return false
  }
  if (result.status !== "ok") {
    res.status(401).json({ error: { code: "owner_password_invalid", message: "That password is not right." } })
    return false
  }
  return true
}
