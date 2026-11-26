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
