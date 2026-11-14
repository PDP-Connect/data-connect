// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getDb } from "../db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";
import type { ChangeLine, SnapshotLine } from "./folder-layout.ts";

export interface ChangeSource {
  listConnections(): Promise<Array<{ connectionId: string; connectorId: string; manifestRef: string | null }>>;
  listStreams(connectionId: string): Promise<Array<{ stream: string; schema: unknown | null }>>;
  resetGeneration(connectionId: string): Promise<number>;
  readChanges(connectionId: string, stream: string, afterVersion: number, maxBytes: number):
    Promise<{ rows: ChangeLine[]; oldestAvailableVersion: number | null }>;
  readSnapshot(connectionId: string, stream: string):
    Promise<{ version: number; generation: number; lines: SnapshotLine[] }>;
}

type Row = Record<string, unknown>;

function integer(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Invalid ${label}: expected a nonnegative safe integer`);
  }
  return number;
}

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid stored manifest");
  }
  return value as Row;
}

function line(row: Row): SnapshotLine {
  if (typeof row.record_key !== "string" || typeof row.emitted_at !== "string") {
    throw new Error("Invalid stored record identity or timestamp");
  }
  return {
    key: row.record_key,
    version: integer(row.version, "record version"),
    emitted_at: row.emitted_at,
    data: json(row.record_json),
  };
}

function deleted(row: Row): boolean {
  return row.deleted === true || row.deleted === 1;
}

/**
 * Uses the existing SQLite handle by default, and the configured Postgres
 * storage when that backend is active. Never returns records.id.
 */
export function createChangeSource(db: ReturnType<typeof getDb> = getDb()): ChangeSource {
  const pg = isPostgresStorageBackend();
  const query = async (sql: string, parameters: string[] = []): Promise<Row[]> => {
    if (pg) {
      return (await postgresQuery(sql, parameters)).rows;
    }
    return db.prepare(sql.replace(/\$\d+/g, "?")).all<Row>(...parameters);
  };
  const generation = (rows: Row[]): number => {
    if (!rows[0]) {
      throw new Error("Connection not found");
    }
    return integer(rows[0].record_reset_generation, "reset generation");
  };

  return {
    async listConnections() {
      const rows = await query(
        `SELECT ci.connector_instance_id, ci.connector_id, c.manifest
         FROM connector_instances ci JOIN connectors c ON c.connector_id = ci.connector_id
         ORDER BY ci.connector_instance_id`
      );
      return rows.map((row) => {
        const manifest = object(json(row.manifest));
        return {
          connectionId: String(row.connector_instance_id),
          connectorId: String(row.connector_id),
          manifestRef: typeof manifest.manifest_ref === "string" ? manifest.manifest_ref : null,
        };
      });
    },

    async listStreams(connectionId) {
      const rows = await query(
        `SELECT c.manifest FROM connector_instances ci
         JOIN connectors c ON c.connector_id = ci.connector_id
         WHERE ci.connector_instance_id = $1`,
        [connectionId]
      );
      if (!rows[0]) {
        throw new Error("Connection not found");
      }
      const manifest = object(json(rows[0].manifest));
      if (!Array.isArray(manifest.streams)) {
        throw new Error("Invalid stored manifest streams");
      }
      return manifest.streams.map((value) => {
        const entry = object(value);
        if (typeof entry.name !== "string") {
          throw new Error("Invalid stored stream name");
        }
        return { stream: entry.name, schema: entry.schema ?? null };
      }).sort((a, b) => a.stream.localeCompare(b.stream));
    },

    async resetGeneration(connectionId) {
      return generation(await query(
        "SELECT record_reset_generation FROM connector_instances WHERE connector_instance_id = $1",
        [connectionId]
      ));
    },

    async readChanges(connectionId, stream, afterVersion, maxBytes) {
      integer(afterVersion, "afterVersion");
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error("maxBytes must be a positive safe integer");
      }
      // The minimum is over ALL retained history, not just rows after the cursor.
      // A single statement gives the minimum and candidate rows one MVCC view.
      const sql = `SELECT changes.*, floor.oldest
        FROM (SELECT MIN(version) AS oldest FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2) floor
        LEFT JOIN record_changes changes ON changes.connector_instance_id = $1
          AND changes.stream = $2 AND changes.version > $3
        ORDER BY changes.version ASC`;
      let candidates: Row[];
      if (pg) {
        candidates = (await postgresQuery(sql, [connectionId, stream, afterVersion])).rows;
      } else {
        // Numbered bindings repeat in the SQL; bind each positional occurrence.
        candidates = db.prepare(sql.replace(/\$\d+/g, "?")).all<Row>(
          connectionId, stream, connectionId, stream, afterVersion
        );
      }
      const oldest = candidates[0]?.oldest;
      const rows: ChangeLine[] = [];
      let bytes = 0;
      for (const candidate of candidates) {
        if (candidate.version === null || candidate.version === undefined) {
          continue;
        }
        // Tombstones may have null/malformed historical payload: never decode it.
        const record = line({ ...candidate, record_json: deleted(candidate) ? null : candidate.record_json });
        const change: ChangeLine = {
          key: record.key, version: record.version,
          op: deleted(candidate) ? "delete" : "upsert",
          emitted_at: record.emitted_at, data: record.data,
        };
        const size = Buffer.byteLength(JSON.stringify(change) + "\n", "utf8");
        if (rows.length > 0 && bytes + size > maxBytes) {
          break;
        }
        rows.push(change);
        bytes += size;
      }
      return {
        rows,
        oldestAvailableVersion: oldest === null || oldest === undefined ? null : integer(oldest, "oldest version"),
      };
    },

    async readSnapshot(connectionId, stream) {
      if (pg) {
        // One SELECT is one MVCC snapshot even at READ COMMITTED. Do not split
        // version, generation and rows into separate statements at that level.
        return withPostgresTransaction(async (client) => {
          const result = await client.query(
            `SELECT ci.record_reset_generation,
              GREATEST(
                COALESCE((SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2), 0),
                COALESCE((SELECT MAX(version) FROM records WHERE connector_instance_id = $1 AND stream = $2), 0),
                COALESCE((SELECT MAX(version) FROM record_changes WHERE connector_instance_id = $1 AND stream = $2), 0)
              ) AS version,
              COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.version, r.record_key)
                FROM (SELECT record_key, version, emitted_at, record_json FROM records
                  WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE) r), '[]'::jsonb) AS lines
             FROM connector_instances ci WHERE ci.connector_instance_id = $1`,
            [connectionId, stream]
          );
          const row = result.rows[0] as Row | undefined;
          if (!row) {
            throw new Error("Connection not found");
          }
          const records = json(row.lines);
          if (!Array.isArray(records)) {
            throw new Error("Invalid snapshot rows");
          }
          return {
            generation: integer(row.record_reset_generation, "reset generation"),
            version: integer(row.version, "snapshot version"),
            lines: records.map((record) => line(object(record))),
          };
        });
      }
      return db.transaction(() => {
        const state = db.prepare(
          "SELECT record_reset_generation FROM connector_instances WHERE connector_instance_id = ?"
        ).all<Row>(connectionId);
        const reset = generation(state);
        const version = db.prepare(`SELECT MAX(v) AS version FROM (
          SELECT COALESCE(MAX(max_version), 0) AS v FROM version_counter WHERE connector_instance_id = ? AND stream = ?
          UNION ALL SELECT COALESCE(MAX(version), 0) AS v FROM records WHERE connector_instance_id = ? AND stream = ?
          UNION ALL SELECT COALESCE(MAX(version), 0) AS v FROM record_changes WHERE connector_instance_id = ? AND stream = ?
        )`).get<Row>(connectionId, stream, connectionId, stream, connectionId, stream);
        const records = db.prepare(
          `SELECT record_key, version, emitted_at, record_json FROM records
           WHERE connector_instance_id = ? AND stream = ? AND deleted = 0
           ORDER BY version ASC, record_key ASC`
        ).all<Row>(connectionId, stream);
        return { generation: reset, version: integer(version?.version, "snapshot version"), lines: records.map(line) };
      })();
    },
  };
}
