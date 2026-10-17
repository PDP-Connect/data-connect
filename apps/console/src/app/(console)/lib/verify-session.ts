// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Data Access Layer (DAL): authoritative owner-session check.
 *
 * Per the 2026 Next.js team guidance — and to survive middleware-bypass classes
 * like CVE-2025-29927 — every dashboard data fetch verifies the owner session
 * here, close to the data source, not in a layout. This is the security
 * boundary; `proxy.ts` is the optimistic-UX redirect layer that runs first.
 *
 * On miss, calls `redirect()` from `next/navigation`, which throws a
 * `NextRedirectError` that Next.js handles natively for both server-component
 * renders and Server Action invocations. That collapses page-level and
 * mutation-level handling into one place — no per-call-site try/catch.
 *
 * Every request asks the AS to validate the forwarded opaque session cookie.
 * This works when only the AS has the password and lets the AS admit its open
 * local-dev posture without the console inventing an owner identity. `/v1/*`
 * requests carry the owner bearer instead, and the RS checks only that bearer,
 * so `getOwnerToken()` also asks the AS to admit the current request before it
 * hands the bearer out (see owner-token.ts).
 *
 * Memoized with React's `cache()` so a single render that fans out to many
 * sibling fetchers verifies once, not N times. The memoization key is the
 * `returnTo` argument; the default-no-arg call shares one cache entry across
 * all sibling fetchers in a render.
 *
 * See:
 * - openspec/changes/gate-ref-reads-when-owner-auth-enabled/
 * - openspec/changes/honor-csrf-exemption-for-bff-device-flow/
 */
import "server-only";

import { cache } from "react";
import { redirectToOwnerLogin } from "./login-redirect.ts";
import { readDashboardOwnerSession } from "./owner-token.ts";

async function hasValidSession(): Promise<boolean> {
  return await readDashboardOwnerSession();
}

export const verifyDashboardSession = cache(async (returnTo?: string): Promise<void> => {
  if (await hasValidSession()) {
    return;
  }
  await redirectToOwnerLogin(returnTo);
});
