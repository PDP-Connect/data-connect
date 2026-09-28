// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { getDb } from "../db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";
import {
  lockOwnerPasswordVerifierRevision,
  ownerPasswordVerifierRevision,
} from "./owner-password-verifier-store.ts";
import type { OwnerBearerSummary, OwnerSessionRecord, OwnerSessionStore } from "../owner-session.ts";
import { REUSED_OWNER_BEARER_CLIENT_IDS } from "../reference-local-defaults.ts";

interface SessionRow {
  created_at: number | string;
  device_key: string | null;
  expires_at: number | string;
  id_hash: string;
  ip_address: string | null;
  label: string;
  last_seen_at: number | string;
  revoked_at: number | string | null;
  session_id: string;
  subject_id: string;
  user_agent: string | null;
}

interface OwnerBearerRow {
  client_id: string | null;
  client_name: string | null;
  created_at: string;
  expires_at: string | null;
  token_id: string;
}

interface VerifierFenceRow {
  verifier_json: string;
}

function toSessionRecord(row: SessionRow): OwnerSessionRecord {
  return {
    idHash: row.id_hash,
    publicId: row.session_id,
    sub: row.subject_id,
    iat: Number(row.created_at),
    exp: Number(row.expires_at),
    label: row.label,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    deviceKey: row.device_key,
    lastSeenAt: Number(row.last_seen_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

function publicBearerId(token: string): string {
  return `tok_${createHash("sha256").update(token).digest("base64url")}`;
}

function toUtcTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const normalized = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

function projectBearer(row: OwnerBearerRow): OwnerBearerSummary {
  return {
    id: publicBearerId(row.token_id),
    label: row.client_name || row.client_id || "Command line app",
    createdAt: toUtcTimestamp(row.created_at) ?? row.created_at,
    expiresAt: toUtcTimestamp(row.expires_at),
  };
}

function selectOwnerBearerSql(): string {
  return isPostgresStorageBackend()
    ? `SELECT t.token_id, t.client_id, t.created_at, t.expires_at,
              COALESCE(NULLIF(o.metadata_json->>'client_name', ''), NULLIF(o.metadata_json->>'name', '')) AS client_name
         FROM tokens AS t
         LEFT JOIN oauth_clients AS o ON o.client_id = t.client_id
        WHERE t.subject_id = $1 AND t.token_kind = 'owner' AND t.revoked = FALSE
        ORDER BY t.created_at DESC`
    : `SELECT t.token_id, t.client_id, t.created_at, t.expires_at,
              COALESCE(NULLIF(json_extract(o.metadata_json, '$.client_name'), ''), NULLIF(json_extract(o.metadata_json, '$.name'), '')) AS client_name
         FROM tokens AS t
         LEFT JOIN oauth_clients AS o ON o.client_id = t.client_id
        WHERE t.subject_id = ? AND t.token_kind = 'owner' AND t.revoked = 0
        ORDER BY t.created_at DESC`;
}

function createDatabaseOwnerSessionStore(): OwnerSessionStore {
  return {
    async createSession(record, expectedCredentialRevision): Promise<boolean> {
      if (isPostgresStorageBackend()) {
        return await withPostgresTransaction(async (client) => {
          if (expectedCredentialRevision !== undefined) {
            await lockOwnerPasswordVerifierRevision(client);
            const row = (
              await client.query<VerifierFenceRow>(
                "SELECT verifier_json FROM owner_password_verifier WHERE singleton = 1 FOR UPDATE"
              )
            ).rows[0];
            if (!row || ownerPasswordVerifierRevision(row.verifier_json) !== expectedCredentialRevision) return false;
          }
          await client.query(
            `INSERT INTO owner_sessions(id_hash, session_id, subject_id, device_key, label, user_agent, ip_address, created_at, expires_at, last_seen_at, revoked_at)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
           ON CONFLICT(subject_id, device_key) DO UPDATE SET
             id_hash = EXCLUDED.id_hash, label = EXCLUDED.label, user_agent = EXCLUDED.user_agent,
             ip_address = EXCLUDED.ip_address, created_at = EXCLUDED.created_at,
             expires_at = EXCLUDED.expires_at, last_seen_at = EXCLUDED.last_seen_at, revoked_at = NULL`,
            [record.idHash, record.publicId, record.sub, record.deviceKey, record.label, record.userAgent, record.ipAddress, record.iat, record.exp, record.lastSeenAt]
          );
          return true;
        });
      }
      return getDb()
        .transaction(() => {
          if (expectedCredentialRevision !== undefined) {
            const row = getDb()
              .prepare("SELECT verifier_json FROM owner_password_verifier WHERE singleton = 1")
              .get<VerifierFenceRow>();
            if (!row || ownerPasswordVerifierRevision(row.verifier_json) !== expectedCredentialRevision) return false;
          }
          getDb()
          .prepare(
            `INSERT INTO owner_sessions(id_hash, session_id, subject_id, device_key, label, user_agent, ip_address, created_at, expires_at, last_seen_at, revoked_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT(subject_id, device_key) DO UPDATE SET
               id_hash = excluded.id_hash, label = excluded.label, user_agent = excluded.user_agent,
               ip_address = excluded.ip_address, created_at = excluded.created_at,
               expires_at = excluded.expires_at, last_seen_at = excluded.last_seen_at, revoked_at = NULL`
          )
            .run(record.idHash, record.publicId, record.sub, record.deviceKey, record.label, record.userAgent, record.ipAddress, record.iat, record.exp, record.lastSeenAt);
          return true;
        })
        .immediate();
    },
    async readSession(idHash, nowSeconds): Promise<OwnerSessionRecord | null> {
      const row = isPostgresStorageBackend()
        ? (await postgresQuery<SessionRow>(
            `SELECT * FROM owner_sessions WHERE id_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
            [idHash, nowSeconds]
          )).rows[0]
        : getDb()
            .prepare("SELECT * FROM owner_sessions WHERE id_hash = ? AND revoked_at IS NULL AND expires_at > ?")
            .get<SessionRow>(idHash, nowSeconds);
      return row ? toSessionRecord(row) : null;
    },
    async revokeSession(idHash, nowSeconds): Promise<void> {
      if (isPostgresStorageBackend()) {
        await postgresQuery("UPDATE owner_sessions SET revoked_at = $1 WHERE id_hash = $2 AND revoked_at IS NULL", [nowSeconds, idHash]);
      } else {
        getDb().prepare("UPDATE owner_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL").run(nowSeconds, idHash);
      }
    },
    async touchSession(idHash, nowSeconds): Promise<void> {
      if (isPostgresStorageBackend()) {
        await postgresQuery("UPDATE owner_sessions SET last_seen_at = $1 WHERE id_hash = $2 AND last_seen_at <= $3", [nowSeconds, idHash, nowSeconds - 30]);
      } else {
        getDb().prepare("UPDATE owner_sessions SET last_seen_at = ? WHERE id_hash = ? AND last_seen_at <= ?").run(nowSeconds, idHash, nowSeconds - 30);
      }
    },
    async listSessions(subjectId, nowSeconds): Promise<readonly OwnerSessionRecord[]> {
      const rows = isPostgresStorageBackend()
        ? (await postgresQuery<SessionRow>(
            "SELECT * FROM owner_sessions WHERE subject_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY created_at DESC",
            [subjectId, nowSeconds]
          )).rows
        : getDb()
            .prepare("SELECT * FROM owner_sessions WHERE subject_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
            .all<SessionRow>(subjectId, nowSeconds);
      return rows.map(toSessionRecord);
    },
    async revokeOtherSessions(subjectId, keepIdHash, nowSeconds): Promise<void> {
      if (isPostgresStorageBackend()) {
        await postgresQuery(
          "UPDATE owner_sessions SET revoked_at = $1 WHERE subject_id = $2 AND id_hash <> $3 AND revoked_at IS NULL",
          [nowSeconds, subjectId, keepIdHash]
        );
      } else {
        getDb()
          .prepare("UPDATE owner_sessions SET revoked_at = ? WHERE subject_id = ? AND id_hash <> ? AND revoked_at IS NULL")
          .run(nowSeconds, subjectId, keepIdHash);
      }
    },
    async revokeAllSessions(subjectId, nowSeconds): Promise<void> {
      if (isPostgresStorageBackend()) {
        await postgresQuery("UPDATE owner_sessions SET revoked_at = $1 WHERE subject_id = $2 AND revoked_at IS NULL", [
          nowSeconds,
          subjectId,
        ]);
      } else {
        getDb().prepare("UPDATE owner_sessions SET revoked_at = ? WHERE subject_id = ? AND revoked_at IS NULL").run(nowSeconds, subjectId);
      }
    },
    async revokeByPublicId(subjectId, publicId, nowSeconds): Promise<boolean> {
      const row = isPostgresStorageBackend()
        ? (await postgresQuery<{ id_hash: string }>(
            "SELECT id_hash FROM owner_sessions WHERE subject_id = $1 AND session_id = $2 AND revoked_at IS NULL",
            [subjectId, publicId]
          )).rows[0]
        : getDb()
            .prepare("SELECT id_hash FROM owner_sessions WHERE subject_id = ? AND session_id = ? AND revoked_at IS NULL")
            .get<{ id_hash: string }>(subjectId, publicId);
      if (!row) return false;
      await this.revokeSession(row.id_hash, nowSeconds);
      return true;
    },
    async listOwnerBearers(subjectId, nowSeconds): Promise<readonly OwnerBearerSummary[]> {
      const rows = isPostgresStorageBackend()
        ? (await postgresQuery<OwnerBearerRow>(selectOwnerBearerSql(), [subjectId])).rows
        : getDb().prepare(selectOwnerBearerSql()).all<OwnerBearerRow>(subjectId);
      return rows
        .filter((row) => !row.expires_at || Date.parse(row.expires_at) > nowSeconds * 1000)
        .map(projectBearer);
    },
    async revokeOwnerBearer(subjectId, publicId, nowSeconds): Promise<boolean> {
      const rows = isPostgresStorageBackend()
        ? (await postgresQuery<OwnerBearerRow>(selectOwnerBearerSql(), [subjectId])).rows
        : getDb().prepare(selectOwnerBearerSql()).all<OwnerBearerRow>(subjectId);
      const token = rows.find(
        (row) => (!row.expires_at || Date.parse(row.expires_at) > nowSeconds * 1000) && publicBearerId(row.token_id) === publicId
      )?.token_id;
      if (!token) return false;
      if (isPostgresStorageBackend()) {
        const result = await postgresQuery(
          "UPDATE tokens SET revoked = TRUE WHERE token_id = $1 AND subject_id = $2 AND token_kind = 'owner' AND revoked = FALSE",
          [token, subjectId]
        );
        return (result.rowCount ?? 0) > 0;
      }
      return getDb()
        .prepare("UPDATE tokens SET revoked = 1 WHERE token_id = ? AND subject_id = ? AND token_kind = 'owner' AND revoked = 0")
        .run(token, subjectId).changes > 0;
    },
  };
}

/**
 * An approval this soon after the request had no person in the loop: the
 * connector runtime requested and approved its own `cli_longview` bearer in
 * one step. A person signing a CLI in takes longer than this.
 */
const IN_PROCESS_APPROVAL_MAX_SECONDS = 5;

/** `labelOwnerSession` in owner-auth.ts for a sign-in with no user agent. */
const UNLABELED_DESKTOP_SESSION_LABEL = "Unknown browser";

/**
 * Revoke the owner credentials first-party clients leaked on every start:
 *   - For each `REUSED_OWNER_BEARER_CLIENT_IDS` client, every live bearer of
 *     a subject except the newest, which is the one the next approval reuses.
 *   - `cli_longview` bearers the connector runtime minted for itself. Nothing
 *     uses them now that the runtime mints as its own client. A `cli_longview`
 *     bearer a person approved is kept.
 *   - Desktop sign-ins stored before the app labelled them "This computer":
 *     no label and no user agent, so the server stored an "Unknown browser"
 *     session per app start. The newest one of a subject is kept.
 * Safe to run on every start: a second run revokes nothing.
 */
export async function revokeLeakedFirstPartyOwnerCredentials(
  nowSeconds: number
): Promise<{ bearers: number; sessions: number }> {
  const pg = isPostgresStorageBackend();
  const [live, revoked] = pg ? ["FALSE", "TRUE"] : ["0", "1"];
  const param = (index: number) => (pg ? `$${index}` : "?");
  const clientList = REUSED_OWNER_BEARER_CLIENT_IDS.map((_, index) => param(index + 1)).join(", ");
  const approvalSeconds = pg
    ? "EXTRACT(EPOCH FROM (approved_at::timestamptz - created_at::timestamptz))"
    : "(julianday(approved_at) - julianday(created_at)) * 86400";
  const supersededBearersSql = `UPDATE tokens SET revoked = ${revoked}
      WHERE token_kind = 'owner' AND revoked = ${live} AND client_id IN (${clientList})
        AND token_id <> (
          SELECT kept.token_id FROM tokens AS kept
           WHERE kept.token_kind = 'owner' AND kept.revoked = ${live}
             AND kept.client_id = tokens.client_id AND kept.subject_id = tokens.subject_id
           ORDER BY kept.expires_at DESC, kept.token_id DESC
           LIMIT 1
        )`;
  const runtimeCliBearersSql = `UPDATE tokens SET revoked = ${revoked}
      WHERE token_kind = 'owner' AND revoked = ${live} AND client_id = 'cli_longview'
        AND token_id IN (
          SELECT token_id FROM owner_device_auth
           WHERE client_id = 'cli_longview' AND status = 'approved'
             AND token_id IS NOT NULL AND approved_at IS NOT NULL
             AND ${approvalSeconds} < ${IN_PROCESS_APPROVAL_MAX_SECONDS}
        )`;
  const unlabeledDesktop = (table: string) =>
    `${table}.revoked_at IS NULL AND ${table}.device_key IS NULL AND ${table}.user_agent IS NULL
     AND ${table}.label = '${UNLABELED_DESKTOP_SESSION_LABEL}'`;
  const desktopSessionsSql = `UPDATE owner_sessions SET revoked_at = ${param(1)}
      WHERE ${unlabeledDesktop("owner_sessions")}
        AND id_hash <> (
          SELECT kept.id_hash FROM owner_sessions AS kept
           WHERE kept.subject_id = owner_sessions.subject_id AND ${unlabeledDesktop("kept")}
           ORDER BY kept.created_at DESC, kept.id_hash DESC
           LIMIT 1
        )`;
  if (pg) {
    return await withPostgresTransaction(async (client) => {
      const superseded = await client.query(supersededBearersSql, [...REUSED_OWNER_BEARER_CLIENT_IDS]);
      const runtimeCli = await client.query(runtimeCliBearersSql);
      const sessions = await client.query(desktopSessionsSql, [nowSeconds]);
      return {
        bearers: (superseded.rowCount ?? 0) + (runtimeCli.rowCount ?? 0),
        sessions: sessions.rowCount ?? 0,
      };
    });
  }
  const db = getDb();
  return db.transaction(() => ({
    bearers:
      db.prepare(supersededBearersSql).run(...REUSED_OWNER_BEARER_CLIENT_IDS).changes +
      db.prepare(runtimeCliBearersSql).run().changes,
    sessions: db.prepare(desktopSessionsSql).run(nowSeconds).changes,
  }))();
}

let cachedStore: OwnerSessionStore | null = null;

export function getOwnerSessionStore(): OwnerSessionStore {
  cachedStore ??= createDatabaseOwnerSessionStore();
  return cachedStore;
}
