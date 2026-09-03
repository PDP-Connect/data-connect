// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Durable, single-use storage for the console consent handoff. */

import { getDb, runWithSqliteBusyRetry } from "../db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";

export type ConsentChallengeStatus = "accepted" | "expired" | "pending" | "rejected";

export interface ConsentChallengeRecord {
  readonly authorizeParams: Record<string, string | null>;
  readonly client: unknown;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly id: string;
  readonly ownerSubjectId: string;
  /** Inputs used to resolve the fresh owner-facing model, including client trust. */
  readonly renderModelInputs: unknown;
}

interface ConsentChallengeRow {
  authorization_request_json: unknown;
  client_json: unknown;
  created_at: string;
  expires_at: string;
  id: string;
  owner_subject_id: string;
  render_model_inputs_json: unknown;
}

export interface ConsentChallengeStore {
  consume: (
    id: string,
    ownerSubjectId: string,
    status: "accepted" | "rejected",
    decisionDigest: string | null,
    now?: number
  ) => Promise<ConsentChallengeRecord | null>;
  create: (record: ConsentChallengeRecord) => Promise<void>;
  readPending: (id: string, ownerSubjectId: string, now?: number) => Promise<ConsentChallengeRecord | null>;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}
function json(value: unknown): string {
  return JSON.stringify(value);
}
function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function rowToRecord(row: ConsentChallengeRow): ConsentChallengeRecord {
  return {
    authorizeParams: parseJson(row.authorization_request_json) as Record<string, string | null>,
    client: parseJson(row.client_json),
    createdAt: Date.parse(row.created_at),
    expiresAt: Date.parse(row.expires_at),
    id: row.id,
    ownerSubjectId: row.owner_subject_id,
    renderModelInputs: parseJson(row.render_model_inputs_json),
  };
}

async function expirePending(id: string, ownerSubjectId: string, now: string): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `UPDATE consent_challenges SET status = 'expired', decided_at = COALESCE(decided_at, $3)
      WHERE id = $1 AND owner_subject_id = $2 AND status = 'pending' AND expires_at <= $3`,
      [id, ownerSubjectId, now]
    );
    return;
  }
  await runWithSqliteBusyRetry(() =>
    getDb()
      .prepare(`UPDATE consent_challenges SET status = 'expired', decided_at = COALESCE(decided_at, ?)
    WHERE id = ? AND owner_subject_id = ? AND status = 'pending' AND expires_at <= ?`)
      .run(now, id, ownerSubjectId, now)
  );
}

export function createConsentChallengeStore(): ConsentChallengeStore {
  return {
    async consume(id, ownerSubjectId, status, decisionDigest, now = Date.now()) {
      const nowIso = iso(now);
      await expirePending(id, ownerSubjectId, nowIso);
      if (isPostgresStorageBackend()) {
        const result = await postgresQuery<ConsentChallengeRow>(
          `UPDATE consent_challenges SET status = $3, decision_digest = $4, decided_at = $5
          WHERE id = $1 AND owner_subject_id = $2 AND status = 'pending' AND expires_at > $5
          RETURNING id, owner_subject_id, authorization_request_json, client_json, render_model_inputs_json, created_at, expires_at`,
          [id, ownerSubjectId, status, decisionDigest, nowIso]
        );
        return result.rows[0] ? rowToRecord(result.rows[0]) : null;
      }
      const row = await runWithSqliteBusyRetry(() => {
        const db = getDb();
        const result = db
          .prepare(`UPDATE consent_challenges SET status = ?, decision_digest = ?, decided_at = ?
          WHERE id = ? AND owner_subject_id = ? AND status = 'pending' AND expires_at > ?`)
          .run(status, decisionDigest, nowIso, id, ownerSubjectId, nowIso);
        return result.changes === 1
          ? (db
              .prepare(`SELECT id, owner_subject_id, authorization_request_json, client_json, render_model_inputs_json, created_at, expires_at
          FROM consent_challenges WHERE id = ?`)
              .get(id) as ConsentChallengeRow | undefined)
          : undefined;
      });
      return row ? rowToRecord(row) : null;
    },
    async create(record) {
      const values = [
        record.id,
        record.ownerSubjectId,
        json(record.authorizeParams),
        json(record.client),
        json(record.renderModelInputs),
        iso(record.createdAt),
        iso(record.expiresAt),
      ];
      if (isPostgresStorageBackend()) {
        await postgresQuery(
          `INSERT INTO consent_challenges (id, owner_subject_id, authorization_request_json, client_json, render_model_inputs_json, created_at, expires_at)
          VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)`,
          values
        );
        return;
      }
      await runWithSqliteBusyRetry(() =>
        getDb()
          .prepare(`INSERT INTO consent_challenges (id, owner_subject_id, authorization_request_json, client_json, render_model_inputs_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(...values)
      );
    },
    async readPending(id, ownerSubjectId, now = Date.now()) {
      const nowIso = iso(now);
      await expirePending(id, ownerSubjectId, nowIso);
      if (isPostgresStorageBackend()) {
        const result = await postgresQuery<ConsentChallengeRow>(
          `SELECT id, owner_subject_id, authorization_request_json, client_json, render_model_inputs_json, created_at, expires_at
          FROM consent_challenges WHERE id = $1 AND owner_subject_id = $2 AND status = 'pending'`,
          [id, ownerSubjectId]
        );
        return result.rows[0] ? rowToRecord(result.rows[0]) : null;
      }
      const row = await runWithSqliteBusyRetry(
        () =>
          getDb()
            .prepare(`SELECT id, owner_subject_id, authorization_request_json, client_json, render_model_inputs_json, created_at, expires_at
        FROM consent_challenges WHERE id = ? AND owner_subject_id = ? AND status = 'pending'`)
            .get(id, ownerSubjectId) as ConsentChallengeRow | undefined
      );
      return row ? rowToRecord(row) : null;
    },
  };
}
