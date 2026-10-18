// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared scaffolding for in-process storage-generation race tests.
//
// The scenario every test builds: deferred derived-index work captures the
// storage generation, parks at one await, storage is closed and re-opened on a
// DIFFERENT database (production's close-then-init, no shared state), and the
// parked work is resumed. The new database is seeded so every OTHER guard the
// old work could trip over (manifest check, record-version check, dirty
// revision check) PASSES: same connector, same connector instance, same record
// key and version, same dirty revision, only the record text differs. The
// generation check is then the single remaining thing that stops the old work,
// so a missing generation check shows up as rows in the new database.
//
// Both backends run the same scenarios. SQLite uses two files; PostgreSQL uses
// two scratch databases on the private test cluster.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerConnector } from "../../server/auth.ts";
import { closeDb, getDb, initDb } from "../../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from "../../server/postgres-storage.ts";
import { ingestRecord } from "../../server/records.ts";
import { withTemporaryPostgresDatabase } from "./postgres-temp-database.ts";

export const CONNECTOR_ID = "lifecycle-race-probe";
export const INSTANCE_ID = "cin_lifecycle_race_probe";
export const STREAM = "items";
export const OLD_TEXT = "text that only the OLD database holds";
export const NEW_TEXT = "text that only the NEW database holds";

/** Polls in-process state; each turn yields to the event loop. */
export async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    // biome-ignore lint/performance/noAwaitInLoops: bounded poll of in-process state.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Collects rejections nobody handled: old work must exit cleanly. */
export function trackUnhandledRejections(): { stop: () => unknown[] } {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  return {
    stop: () => {
      process.off("unhandledRejection", onRejection);
      return seen;
    },
  };
}

export interface Gate {
  /** Resolves once the parked work reached the pause. */
  readonly entered: Promise<void>;
  /** Called by the hook at the pause; parks exactly one caller (after `skip` earlier callers). */
  readonly park: () => Promise<void>;
  readonly release: () => void;
}

/** Parks one caller, the (skip+1)th; every other caller passes straight through. */
export function oneShotGate(skip = 0): Gate {
  let enter: () => void = () => undefined;
  let leave: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    leave = resolve;
  });
  let seen = 0;
  return {
    entered,
    park: async () => {
      seen += 1;
      if (seen !== skip + 1) {
        return;
      }
      enter();
      await resumed;
    },
    release: () => leave(),
  };
}

export interface ManifestOptions {
  /** Declare lexical_fields (default true). */
  lexical?: boolean;
  /**
   * Register the manifest without the stream, after the stream's record was ingested: the stream's
   * dirty scope is then a removed-stream scope. Declares a different stream ("other") instead.
   */
  removedStream?: boolean;
  semantic: boolean;
}

export function lifecycleManifest(options: ManifestOptions): Record<string, unknown> {
  return {
    capabilities: { human_interaction: [] },
    connector_id: CONNECTOR_ID,
    display_name: "Lifecycle race probe",
    manifest_uri: `https://registry.pdpp.dev/connectors/${CONNECTOR_ID}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: options.removedStream ? "other" : STREAM,
        primary_key: ["id"],
        query: {
          search: {
            ...(options.lexical === false ? {} : { lexical_fields: ["subject"] }),
            ...(options.semantic ? { semantic_fields: ["subject"] } : {}),
          },
        },
        schema: {
          properties: { id: { type: "string" }, subject: { type: "string" } },
          required: ["id", "subject"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "0.1.0",
  };
}

export const TARGET = { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID };

export function recordEnvelope(key: string, subject: string) {
  return {
    data: { id: key, subject },
    emitted_at: "2026-08-09T00:00:00.000Z",
    key,
    stream: STREAM,
  };
}

export interface DerivedState {
  dirty: Array<{
    attempts: number;
    dirty: number;
    last_error: string | null;
    next_attempt_at: string | null;
    revision: number;
  }>;
  lexicalMeta: number;
  lexicalRows: Array<{ field: string; record_key: string; text: string }>;
  semanticBlob: number;
  semanticMeta: number;
  semanticProgress: number;
  /** SQLite only: the vector index keeps its row ids in a side table. */
  semanticRowid: number;
}

const DIRTY_COLUMNS = "dirty, revision, attempts, last_error, next_attempt_at";

/** Everything the deferred index work can write, read from the CURRENT database. */
export async function derivedState(): Promise<DerivedState> {
  if (isPostgresStorageBackend()) {
    const count = async (table: string): Promise<number> =>
      Number(
        (
          await postgresQuery<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_instance_id = $1`, [
            INSTANCE_ID,
          ])
        ).rows[0]?.n
      );
    const dirty = await postgresQuery<DerivedState["dirty"][number]>(
      `SELECT ${DIRTY_COLUMNS} FROM search_index_dirty WHERE connector_instance_id = $1 ORDER BY stream`,
      [INSTANCE_ID]
    );
    const lexical = await postgresQuery<DerivedState["lexicalRows"][number]>(
      "SELECT record_key, field, value AS text FROM lexical_search_index WHERE connector_instance_id = $1 ORDER BY record_key, field",
      [INSTANCE_ID]
    );
    return {
      dirty: dirty.rows.map((row) => ({ ...row, revision: Number(row.revision) })),
      lexicalMeta: await count("lexical_search_meta"),
      lexicalRows: lexical.rows,
      semanticBlob: await count("semantic_search_blob"),
      semanticMeta: await count("semantic_search_meta"),
      semanticProgress: await count("semantic_search_backfill_progress"),
      semanticRowid: 0,
    };
  }
  const db = getDb();
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_instance_id = ?`).get(INSTANCE_ID) as { n: number })
      .n;
  return {
    dirty: db
      .prepare(`SELECT ${DIRTY_COLUMNS} FROM search_index_dirty WHERE connector_instance_id = ? ORDER BY stream`)
      .all(INSTANCE_ID) as DerivedState["dirty"],
    lexicalMeta: count("lexical_search_meta"),
    lexicalRows: db
      .prepare(
        "SELECT record_key, field, text FROM lexical_search_index WHERE connector_instance_id = ? ORDER BY record_key, field"
      )
      .all(INSTANCE_ID) as DerivedState["lexicalRows"],
    semanticBlob: count("semantic_search_blob"),
    semanticMeta: count("semantic_search_meta"),
    semanticProgress: count("semantic_search_backfill_progress"),
    semanticRowid: count("semantic_search_rowid"),
  };
}

/** A lexical row for a record the database does not hold: stale in both databases. */
export const GHOST_ROW = { field: "subject", record_key: "ghost", text: "stale row for a record that is gone" };

export async function insertGhostLexicalRow(): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      "INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, value) VALUES ($1, $2, $3, $4, $5, $6)",
      [CONNECTOR_ID, INSTANCE_ID, STREAM, GHOST_ROW.record_key, GHOST_ROW.field, GHOST_ROW.text]
    );
    return;
  }
  getDb()
    .prepare(
      "INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(CONNECTOR_ID, INSTANCE_ID, STREAM, GHOST_ROW.record_key, GHOST_ROW.field, GHOST_ROW.text);
}

/** Makes the current database's lexical index exactly in sync with k1, with the fingerprint a backfill expects. */
export async function seedInSyncLexicalIndex(text: string): Promise<void> {
  const fingerprint = JSON.stringify(["subject"]);
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      "INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, value) VALUES ($1, $2, $3, 'k1', 'subject', $4)",
      [CONNECTOR_ID, INSTANCE_ID, STREAM, text]
    );
    await postgresQuery(
      "INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, updated_at) VALUES ($1, $2, $3, $4, '2026-08-09T00:00:00.000Z')",
      [CONNECTOR_ID, INSTANCE_ID, STREAM, fingerprint]
    );
    return;
  }
  const db = getDb();
  db.prepare(
    "INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text) VALUES (?, ?, ?, 'k1', 'subject', ?)"
  ).run(CONNECTOR_ID, INSTANCE_ID, STREAM, text);
  db.prepare(
    "INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint) VALUES (?, ?, ?, ?)"
  ).run(CONNECTOR_ID, INSTANCE_ID, STREAM, fingerprint);
}

/** Leftover semantic meta for the stream, as if semantic search had once been on. */
export async function insertStaleSemanticMeta(): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      "INSERT INTO semantic_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at) VALUES ($1, $2, $3, '[]', 'old-model', 8, 'cosine', '2026-08-09T00:00:00.000Z')",
      [CONNECTOR_ID, INSTANCE_ID, STREAM]
    );
    return;
  }
  getDb()
    .prepare(
      "INSERT INTO semantic_search_meta(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric) VALUES (?, ?, ?, '[]', 'old-model', 8, 'cosine')"
    )
    .run(INSTANCE_ID, CONNECTOR_ID, STREAM);
}

/** The record text the CURRENT database holds for k1. */
export async function currentRecordText(): Promise<string> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<{ record_json: unknown }>(
      "SELECT record_json FROM records WHERE connector_instance_id = $1 AND record_key = 'k1'",
      [INSTANCE_ID]
    );
    return JSON.stringify(result.rows[0]?.record_json);
  }
  const row = getDb()
    .prepare("SELECT record_json FROM records WHERE connector_instance_id = ? AND record_key = 'k1'")
    .get(INSTANCE_ID) as { record_json: string };
  return row.record_json;
}

/**
 * The new database as seeded: one dirty scope, no derived rows of any kind
 * (or exactly the rows named in `seeded`, for tests that seed a row the old
 * work could delete).
 */
export function assertNewDatabaseUntouched(
  state: DerivedState,
  expectedRevision: number,
  label: string,
  seeded: { lexicalRows?: DerivedState["lexicalRows"]; semanticMeta?: number } = {}
): void {
  const expectedLexicalRows = seeded.lexicalRows ?? [];
  assert.deepEqual(
    state.lexicalRows,
    expectedLexicalRows,
    `${label}: old work changed the new database's lexical rows`
  );
  assert.equal(state.lexicalMeta, 0, `${label}: old work wrote a lexical fingerprint into the new database`);
  assert.equal(state.semanticBlob, 0, `${label}: old work wrote semantic vectors into the new database`);
  assert.equal(state.semanticRowid, 0, `${label}: old work wrote semantic row ids into the new database`);
  assert.equal(
    state.semanticMeta,
    seeded.semanticMeta ?? 0,
    `${label}: old work changed the semantic meta of the new database`
  );
  assert.equal(state.semanticProgress, 0, `${label}: old work wrote semantic progress into the new database`);
  assert.equal(state.dirty.length, 1, `${label}: the new database keeps its one dirty scope`);
  const [scope] = state.dirty;
  assert.ok(scope);
  assert.equal(scope.dirty, 1, `${label}: old work cleared the new database's dirty mark`);
  assert.equal(scope.revision, expectedRevision, `${label}: the new database's dirty revision changed`);
  assert.equal(scope.last_error, null, `${label}: old work wrote failure evidence into the new database`);
  assert.equal(scope.attempts, 0, `${label}: old work advanced the new database's retry state`);
  assert.equal(scope.next_attempt_at, null, `${label}: old work set a backoff on the new database`);
}

export interface TwoDatabases {
  /** Seed database A: manifest registered, k1 ingested. Leaves A open. */
  openOld: (options: ManifestOptions & { deferIndexes: boolean }) => Promise<{ revision: number }>;
  /** Close A and open the fresh database B the way production does. Seeds B so every other guard passes. */
  replaceWithFresh: (options: ManifestOptions) => Promise<{ revision: number }>;
}

async function currentRevision(): Promise<number> {
  return (await derivedState()).dirty[0]?.revision ?? 0;
}

async function seed(
  options: ManifestOptions,
  text: string,
  ingestOptions: { deferIndexes: true } | Record<string, never>
): Promise<{ revision: number }> {
  // A removed-stream scope needs the stream declared while its record is ingested.
  await registerConnector(lifecycleManifest({ ...options, removedStream: false }), { backfillRetrievalIndexes: false });
  await ingestRecord(TARGET, recordEnvelope("k1", text), ingestOptions);
  if (options.removedStream) {
    await registerConnector(lifecycleManifest(options), { backfillRetrievalIndexes: false });
  }
  return { revision: await currentRevision() };
}

function seedOld(options: ManifestOptions & { deferIndexes: boolean }): Promise<{ revision: number }> {
  const { deferIndexes, ...manifestOptions } = options;
  return seed(manifestOptions, OLD_TEXT, deferIndexes ? { deferIndexes: true } : {});
}

// Same instance, same key => same version 1; deferred so the new database's own index work never runs.
function seedNew(options: ManifestOptions): Promise<{ revision: number }> {
  return seed(options, NEW_TEXT, { deferIndexes: true });
}

/** Runs `body` with two on-disk SQLite paths; always closes storage and removes the files. */
export async function withTwoSqliteDatabases<T>(body: (dbs: TwoDatabases) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-lifecycle-race-"));
  try {
    return await body({
      openOld: (options) => {
        initDb(join(dir, "old.sqlite"));
        return seedOld(options);
      },
      replaceWithFresh: (options) => {
        closeDb();
        initDb(join(dir, "new.sqlite"));
        return seedNew(options);
      },
    });
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

/** Runs `body` with two scratch databases on the private PostgreSQL test cluster. */
export async function withTwoPostgresDatabases<T>(
  connectionString: string,
  body: (dbs: TwoDatabases) => Promise<T>
): Promise<T> {
  const suffix = `${process.pid}_${Date.now().toString(36)}`;
  // withTemporaryPostgresDatabase is typed to return unknown; it returns the callback's value.
  return (await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString, databaseName: `pdpp_lifecycle_old_${suffix}` },
    async (oldUrl) =>
      await withTemporaryPostgresDatabase(
        { closeConnections: closePostgresStorage, connectionString, databaseName: `pdpp_lifecycle_new_${suffix}` },
        async (newUrl) => {
          initDb(":memory:");
          try {
            return await body({
              openOld: async (options) => {
                await initPostgresStorage({ backend: "postgres", databaseUrl: oldUrl });
                return await seedOld(options);
              },
              replaceWithFresh: async (options) => {
                await closePostgresStorage();
                await initPostgresStorage({ backend: "postgres", databaseUrl: newUrl });
                return await seedNew(options);
              },
            });
          } finally {
            await closePostgresStorage();
            closeDb();
          }
        }
      )
  )) as T;
}

export interface BackendKit {
  readonly name: "SQLite" | "PostgreSQL";
  readonly run: <T>(body: (dbs: TwoDatabases) => Promise<T>) => Promise<T>;
  /** A skip reason, or false when this backend can run here. */
  readonly skip: string | false;
}

const postgresUrl = process.env.PDPP_TEST_POSTGRES_URL;

export const backendKits: readonly BackendKit[] = [
  { name: "SQLite", run: withTwoSqliteDatabases, skip: false },
  {
    name: "PostgreSQL",
    run: (body) => {
      assert.ok(postgresUrl);
      return withTwoPostgresDatabases(postgresUrl, body);
    },
    skip: postgresUrl ? false : "PDPP_TEST_POSTGRES_URL unset",
  },
];
