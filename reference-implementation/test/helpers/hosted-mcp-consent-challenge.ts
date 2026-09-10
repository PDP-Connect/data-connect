// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

/** Start the real authorization transaction before submitting a legacy form. */
export async function bindHostedMcpConsentChallenge(asUrl: string, params: URLSearchParams): Promise<void> {
  const authorizeUrl = new URL("/oauth/authorize", asUrl);
  for (const key of ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method"]) {
    const value = params.get(key);
    if (value !== null) {
      authorizeUrl.searchParams.set(key, value);
    }
  }
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(response.status, 302, "authorization must hand off to a consent challenge");
  const location = response.headers.get("location");
  assert.ok(location, "authorization must provide a consent redirect");
  const challenge = new URL(location, asUrl).searchParams.get("challenge");
  assert.ok(challenge, "authorization must create a consent challenge");
  params.set("consent_challenge", challenge);
}
