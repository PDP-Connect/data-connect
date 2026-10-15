// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Public read cursors are opaque random references to RS-held state.
//
// A storage backend still encodes its own page position and change version.
// That internal cursor never leaves the RS: the route stores it here under a
// random token, together with a digest of the authenticated query context the
// token is bound to. A client sees only the random token, so it learns no
// position, time, field value, or stored instance from it, and two tokens
// compare equal only by chance. Only startup creates the table
// (`rs_opaque_cursors` in db.ts and postgres-storage.ts); reads only insert,
// select, and delete rows. Rows hold compact metadata, never record payloads.

import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "./postgres-storage.ts";

export type RsCursorKind = "page" | "changes_page" | "changes_since";

/** Ordinary and changes pages are short-lived; sync checkpoints last longer. */
export const RS_CURSOR_TTL_MS: Readonly<Record<RsCursorKind, number>> = {
  changes_page: 24 * 60 * 60 * 1000,
  changes_since: 30 * 24 * 60 * 60 * 1000,
  page: 24 * 60 * 60 * 1000,
};

/** Live tokens kept per authenticated scope and kind; the oldest go first. */
export const RS_CURSOR_QUOTA: Readonly<Record<RsCursorKind, number>> = {
  changes_page: 1000,
  changes_since: 100,
  page: 1000,
};

const TOKEN_PREFIX = "pdc_";

type CursorError = Error & { code: string; param: string };

function cursorError(code: string, param: string, message: string): CursorError {
  return Object.assign(new Error(message), { code, param });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => {
        if (left < right) {
          return -1;
        }
        if (left > right) {
          return 1;
        }
        return 0;
      });
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Digest of a context object; key order does not matter. */
export function rsCursorDigest(context: unknown): string {
  return sha256(canonicalJson(context));
}

interface CursorRow {
  context_digest: string;
  expires_at: number | string;
  internal_cursor: string;
  kind: string;
}

async function insertRow(row: {
  contextDigest: string;
  createdAt: number;
  expiresAt: number;
  internalCursor: string;
  kind: RsCursorKind;
  scopeDigest: string;
  tokenDigest: string;
}): Promise<void> {
  const quota = RS_CURSOR_QUOTA[row.kind];
  if (isPostgresStorageBackend()) {
    await withPostgresTransaction(async (client) => {
      // Expiry cleanup spans every scope. One registry-wide transaction lock
      // makes cleanup, quota insertion, and eviction one serialized decision.
      // This intentionally trades write throughput for a strict per-scope/kind row cap.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pdpp'), hashtext('rs_opaque_cursors.issue'))");
      await client.query("DELETE FROM rs_opaque_cursors WHERE expires_at < $1", [row.createdAt]);
      await client.query(
        `INSERT INTO rs_opaque_cursors
         (token_digest, kind, scope_digest, context_digest, internal_cursor, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.tokenDigest,
          row.kind,
          row.scopeDigest,
          row.contextDigest,
          row.internalCursor,
          row.createdAt,
          row.expiresAt,
        ]
      );
      await client.query(
        `DELETE FROM rs_opaque_cursors
        WHERE token_digest IN (
          SELECT token_digest FROM rs_opaque_cursors
           WHERE scope_digest = $1 AND kind = $2
           ORDER BY created_at DESC, token_digest DESC
           OFFSET $3)`,
        [row.scopeDigest, row.kind, quota]
      );
    });
    return;
  }
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM rs_opaque_cursors WHERE expires_at < ?").run(row.createdAt);
    db.prepare(
      `INSERT INTO rs_opaque_cursors
       (token_digest, kind, scope_digest, context_digest, internal_cursor, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.tokenDigest,
      row.kind,
      row.scopeDigest,
      row.contextDigest,
      row.internalCursor,
      row.createdAt,
      row.expiresAt
    );
    db.prepare(
      `DELETE FROM rs_opaque_cursors
      WHERE token_digest IN (
        SELECT token_digest FROM rs_opaque_cursors
         WHERE scope_digest = ? AND kind = ?
         ORDER BY created_at DESC, token_digest DESC
         LIMIT -1 OFFSET ?)`
    ).run(row.scopeDigest, row.kind, quota);
  }).immediate();
}

async function selectRow(tokenDigest: string): Promise<CursorRow | null> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<CursorRow & Record<string, unknown>>(
      "SELECT kind, context_digest, internal_cursor, expires_at FROM rs_opaque_cursors WHERE token_digest = $1",
      [tokenDigest]
    );
    return result.rows[0] ?? null;
  }
  return (
    (getDb()
      .prepare("SELECT kind, context_digest, internal_cursor, expires_at FROM rs_opaque_cursors WHERE token_digest = ?")
      .get(tokenDigest) as CursorRow | undefined) ?? null
  );
}

/**
 * Store an internal storage cursor and return a fresh opaque public token.
 * `scope` identifies the authenticated caller for quota accounting.
 */
export async function issueRsCursor(args: {
  context: unknown;
  internalCursor: string;
  kind: RsCursorKind;
  now?: number;
  scope: unknown;
}): Promise<string> {
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const createdAt = args.now ?? Date.now();
  await insertRow({
    contextDigest: rsCursorDigest(args.context),
    createdAt,
    expiresAt: createdAt + RS_CURSOR_TTL_MS[args.kind],
    internalCursor: args.internalCursor,
    kind: args.kind,
    scopeDigest: rsCursorDigest(args.scope),
    tokenDigest: sha256(token),
  });
  return token;
}

/**
 * Resolve a public token to its internal storage cursor. The token must be of
 * an accepted kind and bound to exactly this context. A page cursor that is
 * unknown, expired, or bound to another context is `invalid_cursor`. A
 * `changes_since` token bound to another context is `invalid_cursor`; one the
 * RS no longer holds is 410 `cursor_expired`, so the client restarts from
 * `beginning`.
 */
export async function resolveRsCursor(args: {
  accept: readonly RsCursorKind[];
  context: unknown;
  now?: number;
  param: "changes_since" | "cursor";
  token: unknown;
}): Promise<{ internalCursor: string; kind: RsCursorKind }> {
  const { param } = args;
  const missing =
    param === "changes_since"
      ? cursorError("cursor_expired", param, "changes_since token is no longer held; start again from beginning")
      : cursorError("invalid_cursor", param, "Cursor is unknown or expired; restart pagination");
  if (typeof args.token !== "string" || !args.token.startsWith(TOKEN_PREFIX)) {
    throw param === "changes_since"
      ? missing
      : cursorError("invalid_cursor", param, "Cursor is not a token this server issued");
  }
  const row = await selectRow(sha256(args.token));
  if (!row || Number(row.expires_at) < (args.now ?? Date.now())) {
    throw missing;
  }
  if (!args.accept.includes(row.kind as RsCursorKind) || row.context_digest !== rsCursorDigest(args.context)) {
    throw cursorError("invalid_cursor", param, "Cursor does not belong to this query context");
  }
  return {
    internalCursor: row.internal_cursor,
    kind: row.kind as RsCursorKind,
  };
}
