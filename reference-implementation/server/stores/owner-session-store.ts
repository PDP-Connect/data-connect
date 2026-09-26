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

let cachedStore: OwnerSessionStore | null = null;

export function getOwnerSessionStore(): OwnerSessionStore {
  cachedStore ??= createDatabaseOwnerSessionStore();
  return cachedStore;
}
