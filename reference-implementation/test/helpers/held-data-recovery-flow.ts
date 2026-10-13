// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drives Core's lifecycle recovery over HTTP: an authorization request that
 * carries a `https://pdpp.dev/grant-lifecycle` element, the owner's review and
 * approval, and the code exchange. PROTOTYPE.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fetchJson, type Harness } from "./training-lease-harness.ts";

export const LIFECYCLE_TYPE = "https://pdpp.dev/grant-lifecycle";
export const RECOVERY_REDIRECT = "https://client.example/callback";

const ownerHeaders = (h: Harness) => ({ Authorization: `Bearer ${h.ownerToken}`, "Content-Type": "application/json" });

export function authorizeUrl(h: Harness, clientId: string, details: unknown, challenge: string, redirect = RECOVERY_REDIRECT) {
  const url = new URL(`${h.asUrl}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", "rec");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("authorization_details", JSON.stringify(details));
  return url;
}

export const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** Authorize, review, and approve. Returns the code and the review the owner saw. */
export async function approveRecovery(h: Harness, clientId: string, grantIds: string[], redirect = RECOVERY_REDIRECT) {
  const { verifier, challenge } = pkce();
  const a = await fetch(authorizeUrl(h, clientId, [{ type: LIFECYCLE_TYPE, grant_ids: grantIds }], challenge, redirect), {
    redirect: "manual",
  });
  assert.equal(a.status, 302, await a.text());
  const reviewUrl = new URL(a.headers.get("location") as string, h.asUrl);
  const review = await fetchJson<Record<string, unknown>>(reviewUrl.toString(), { headers: ownerHeaders(h) });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const approved = await fetchJson<{ redirect_url: string; approval_id: string }>(`${reviewUrl}/approve`, {
    headers: ownerHeaders(h),
    method: "POST",
    body: "{}",
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const code = new URL(approved.body.redirect_url).searchParams.get("code") as string;
  assert.ok(code);
  return { code, verifier, review: review.body, approvalId: approved.body.approval_id, redirect };
}

export function tokenForm(clientId: string, code: string, verifier: string, redirect = RECOVERY_REDIRECT) {
  return {
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirect,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  };
}

/** The whole recovery for a public client: returns the token response body. */
export async function recoverLifecycle(h: Harness, clientId: string, grantIds: string[]) {
  const { code, verifier, review } = await approveRecovery(h, clientId, grantIds);
  const token = await fetchJson<{
    access_token: string;
    token_type: string;
    authorization_details?: { type: string; grant_ids: string[] }[];
    refresh_token?: string;
  }>(`${h.asUrl}/oauth/token`, tokenForm(clientId, code, verifier));
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return { ...token.body, review };
}
