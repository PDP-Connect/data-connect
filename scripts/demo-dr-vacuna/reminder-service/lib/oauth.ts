// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// OAuth client side of the reminder service: private_key_jwt client
// authentication (RFC 7523) and refresh-token rotation that never replays a
// refresh token.

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ReminderStore } from "./store.ts";

export const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export interface ClientCredentials {
  /** Form fields that authenticate the client (client_id for a public client). */
  fields: () => Record<string, string>;
  readonly clientId: string;
}

export function publicClient(clientId: string): ClientCredentials {
  return { clientId, fields: () => ({ client_id: clientId }) };
}

/** RFC 7523 private_key_jwt with an ES256 key; `aud` is the AS issuer (PR #401). */
export function privateKeyJwtClient(opts: {
  clientId: string;
  issuer: string;
  key: KeyObject;
  kid: string;
  lifetimeSeconds?: number;
}): ClientCredentials {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: opts.kid, typ: "JWT" })).toString("base64url");
  return {
    clientId: opts.clientId,
    fields: () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(
        JSON.stringify({
          aud: opts.issuer,
          exp: now + (opts.lifetimeSeconds ?? 60),
          iat: now,
          iss: opts.clientId,
          jti: randomUUID(),
          sub: opts.clientId,
        })
      ).toString("base64url");
      const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: opts.key });
      return {
        client_assertion: `${header}.${payload}.${sig.toString("base64url")}`,
        client_assertion_type: JWT_BEARER,
        client_id: opts.clientId,
      };
    },
  };
}

/** Loads (or creates, mode 0600) the client's ES256 signing key and returns its public JWK. */
export function loadOrCreateClientKey(path: string): { jwk: Record<string, unknown>; key: KeyObject; kid: string } {
  let key: KeyObject;
  if (existsSync(path)) {
    key = createPrivateKey(readFileSync(path, "utf8"));
  } else {
    key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    writeFileSync(path, key.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  }
  const pub = createPublicKey(key).export({ format: "jwk" }) as Record<string, unknown>;
  const kid = `reminder-${String(pub.x).slice(0, 8)}`;
  return { jwk: { ...pub, alg: "ES256", kid, use: "sig" }, key, kid };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type RefreshOutcome =
  | { kind: "refreshed"; accessToken: string }
  /** The AS refused the token (invalid_grant): the family is dead; re-authorization needed. */
  | { kind: "dead"; error: string }
  /** No answer we can trust: the AS may have rotated. Never retried. */
  | { kind: "lost"; error: string }
  /** Request never reached rotation (client auth refused, or another refresh state recorded). */
  | { kind: "skipped"; error: string };

/**
 * Rotates child `childIndex`'s refresh token. Order of operations:
 *   1. commit refresh_state = in_flight (only from idle, with this token);
 *   2. POST grant_type=refresh_token once, never retried;
 *   3. on success commit the new refresh + access token, then return the
 *      access token for use; on invalid_grant mark dead; on anything
 *      ambiguous (network error, timeout, 5xx, unparsable 200) mark lost.
 */
export async function rotateRefreshToken(args: {
  childIndex: number;
  client: ClientCredentials;
  fetchImpl?: FetchLike;
  realNow?: () => number;
  store: ReminderStore;
  timeoutMs?: number;
  tokenEndpoint: string;
}): Promise<RefreshOutcome> {
  const { childIndex, client, store } = args;
  const realNow = args.realNow ?? Date.now;
  const fetchImpl = args.fetchImpl ?? ((url, init) => fetch(url, init));
  const row = store.getChild(childIndex);
  if (!row?.refresh_token) {
    return { error: "no refresh token", kind: "skipped" };
  }
  const presented = row.refresh_token;
  if (!store.beginRefresh(childIndex, presented)) {
    return { error: `refresh_state is ${row.refresh_state}`, kind: "skipped" };
  }
  let status: number;
  let body: Record<string, unknown>;
  try {
    const resp = await fetchImpl(args.tokenEndpoint, {
      body: new URLSearchParams({ ...client.fields(), grant_type: "refresh_token", refresh_token: presented }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(args.timeoutMs ?? 15_000),
    });
    status = resp.status;
    const text = await resp.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (err) {
    store.update(childIndex, { refresh_state: "lost", status: "needs_reauth", status_check_due: 1 });
    return { error: `refresh outcome unknown: ${String((err as Error).message ?? err)}`, kind: "lost" };
  }
  if (status === 200 && typeof body.access_token === "string" && typeof body.refresh_token === "string") {
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
    store.update(childIndex, {
      access_expires_at: expiresIn === null ? null : realNow() + expiresIn * 1000,
      access_token: body.access_token,
      refresh_state: "idle",
      refresh_token: body.refresh_token,
    });
    return { accessToken: body.access_token, kind: "refreshed" };
  }
  if (status === 400 && body.error === "invalid_grant") {
    store.update(childIndex, { refresh_state: "dead", status: "needs_reauth", status_check_due: 1 });
    return { error: String(body.error_description ?? body.error), kind: "dead" };
  }
  if (status === 401 && body.error === "invalid_client") {
    // Client authentication runs before rotation, so the presented token
    // was not consumed and stays usable.
    store.update(childIndex, { refresh_state: "idle" });
    return { error: String(body.error_description ?? "invalid_client"), kind: "skipped" };
  }
  store.update(childIndex, { refresh_state: "lost", status: "needs_reauth", status_check_due: 1 });
  return { error: `refresh outcome unknown: HTTP ${status} ${String(body.error ?? "")}`, kind: "lost" };
}
