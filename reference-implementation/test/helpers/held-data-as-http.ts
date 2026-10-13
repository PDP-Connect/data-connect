// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP helpers for the held-data AS tests: a server with the lifecycle flag on,
 * a registered public client, an authorization-code grant, and the owner and
 * lifecycle calls. PROTOTYPE.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchJson,
  type Harness,
  json,
  trainingDetail,
} from "./training-lease-harness.ts";

export const REDIRECT = "https://client.example/callback";
export const DAY = 24 * 60 * 60 * 1000;

export function heldDataOpts(
  clock?: { now: number },
  extra: Record<string, unknown> = {},
) {
  return {
    experimentalHeldDataLifecycle: {
      journalDir: mkdtempSync(join(tmpdir(), "pdpp-held-v010-journal-")),
      markerDir: mkdtempSync(join(tmpdir(), "pdpp-held-v010-marker-")),
      ...(clock ? { now: () => clock.now } : {}),
      ...extra,
    },
  };
}

export function form(o: Record<string, string>): RequestInit {
  return {
    body: new URLSearchParams(o).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  };
}

export function ordinaryDetail(connectorId: string, extra: Record<string, unknown> = {}) {
  const { processing_permissions: _p, purpose_description: _d, ...rest } = trainingDetail(connectorId, extra);
  return rest;
}

export async function registerPublicClient(h: Harness): Promise<string> {
  const reg = await fetchJson<{ client_id: string }>(
    `${h.asUrl}/oauth/register`,
    json({
      application_type: "web",
      client_name: "Held-data v0.1.0 test client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  );
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  return reg.body.client_id;
}

/** Authorization-code flow for a continuous grant (the only RI flow with refresh tokens). */
export async function authCodeGrant(h: Harness, clientId: string, extra: Record<string, unknown> = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${h.asUrl}/oauth/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", REDIRECT);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", "s1");
  authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set(
    "authorization_details",
    JSON.stringify([ordinaryDetail(h.connectorId, { access_mode: "continuous", ...extra })]),
  );
  const a = await fetch(authorize, { redirect: "manual" });
  assert.equal(a.status, 302, await a.text());
  const requestUri = new URL(a.headers.get("location") as string, h.asUrl).searchParams.get("request_uri");
  const review = await fetchJson<{ approval_review_revision: string }>(
    `${h.asUrl}/consent/review`,
    json({ request_uri: requestUri, subject_id: "owner_local" }),
  );
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const approve = await fetch(`${h.asUrl}/consent/approve`, {
    ...json({ approval_review_revision: review.body.approval_review_revision, request_uri: requestUri }),
    redirect: "manual",
  });
  assert.equal(approve.status, 302);
  const code = new URL(approve.headers.get("location") as string).searchParams.get("code") as string;
  const token = await fetchJson<{ access_token: string; refresh_token: string; grant_id: string }>(
    `${h.asUrl}/oauth/token`,
    form({ client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: REDIRECT }),
  );
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return { accessToken: token.body.access_token, grantId: token.body.grant_id, refreshToken: token.body.refresh_token };
}

export async function lifecycle(h: Harness, params: Record<string, string>) {
  return fetchJson<{ grants: Record<string, unknown>[]; error?: string }>(`${h.asUrl}/oauth/grant-lifecycle`, form(params));
}

export const status = (h: Harness, token: string, grantId: string) => lifecycle(h, { grant_id: grantId, token });

export async function owner(h: Harness, path: string, method: "GET" | "POST" = "GET") {
  return fetchJson<Record<string, unknown>>(`${h.asUrl}${path}`, {
    headers: { Authorization: `Bearer ${h.ownerToken}`, "Content-Type": "application/json" },
    method,
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}

export async function rsRead(h: Harness, token: string) {
  return (await fetch(`${h.rsUrl}/v1/streams/top_artists/records`, { headers: { Authorization: `Bearer ${token}` } })).status;
}

/** An owner erase on a grant, then the instruction as the lifecycle query returns it. */
export async function eraseAndGetInstruction(h: Harness, grantId: string, token: string) {
  const erase = await owner(h, `/v1/owner/grants/${grantId}/lifecycle/erase`, "POST");
  assert.equal(erase.status, 200, JSON.stringify(erase.body));
  const q = await status(h, token, grantId);
  return (q.body.grants[0] as { erasure: { instruction_id: string } }).erasure.instruction_id;
}
