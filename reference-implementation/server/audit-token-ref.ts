// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-safe reference to a presented bearer token.
 *
 * Spine events used to store the literal bearer in `spine_events.token_id`
 * (request-path `query.*`, `disclosure.served`, `state.*`, `mutation.*`, and
 * AS `token.issued`-style events), so anyone who could read the audit log
 * could replay a live token. Both spine writers (`lib/spine.ts`,
 * `lib/postgres-spine.ts`) now store `tkh_<base64url HMAC-SHA256(key,
 * bearer)>` instead: one-way, stable for a given key, so every request
 * (including denials with unknown, expired or revoked tokens) made with the
 * same bearer still correlates. Bearers stay as-is in the AS `tokens` table,
 * which is the credential store, not the audit log.
 *
 * Key: `PDPP_AUDIT_TOKEN_HMAC_KEY` (at least 32 characters). Without it a
 * random per-process key is used, which keeps the bearer out of the log but
 * only correlates within one process lifetime. Set the env var wherever audit
 * rows must correlate across restarts. A plain unkeyed hash is not used: the
 * AS mints 64-hex bearers, and an unkeyed digest would let a log reader confirm
 * a guessed or leaked token.
 */

import { createHmac, randomBytes } from "node:crypto";

export const AUDIT_TOKEN_REF_PREFIX = "tkh_";
const MIN_KEY_LENGTH = 32;

let cachedKey: Buffer | null = null;

function resolveKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const configured = process.env.PDPP_AUDIT_TOKEN_HMAC_KEY;
  if (configured !== undefined && configured !== "") {
    if (configured.length < MIN_KEY_LENGTH) {
      throw new Error(`PDPP_AUDIT_TOKEN_HMAC_KEY must be at least ${MIN_KEY_LENGTH} characters`);
    }
    cachedKey = Buffer.from(configured, "utf8");
  } else {
    cachedKey = randomBytes(32);
  }
  return cachedKey;
}

/**
 * Keyed, non-reversible audit reference for a bearer token; null when absent.
 * Idempotent: a value that is already a reference is returned unchanged, so
 * the spine writers can apply it to every `token_id` they persist. AS-minted
 * bearers are hex and never carry the `tkh_` prefix.
 */
export function auditTokenRef(token: string | null | undefined): string | null {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  if (token.startsWith(AUDIT_TOKEN_REF_PREFIX)) {
    return token;
  }
  return `${AUDIT_TOKEN_REF_PREFIX}${createHmac("sha256", resolveKey()).update(token, "utf8").digest("base64url")}`;
}

/**
 * Audit reference for an `Authorization` header value: the text after
 * `Bearer `, as every emitter extracted it before. Other schemes (or no
 * header) have no bearer to correlate and yield null.
 */
export function auditTokenRefFromAuthorization(header: unknown): string | null {
  return typeof header === "string" && header.startsWith("Bearer ") ? auditTokenRef(header.slice(7)) : null;
}

/** Test seam: forget the cached key so the next call re-reads the env. */
export function resetAuditTokenRefKeyForTests(): void {
  cachedKey = null;
}
