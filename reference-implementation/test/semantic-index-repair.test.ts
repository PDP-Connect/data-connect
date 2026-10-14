// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore-all lint/performance/noAwaitInLoops: fixtures seed and drive passes strictly sequentially.
// biome-ignore-all lint/performance/useTopLevelRegex: one-shot assertion patterns inside single-use test bodies.
// biome-ignore-all lint/style/useDestructuring: row[0] access reads clearer than destructuring in these fixtures.
// biome-ignore-all lint/suspicious/useAwait: scenario callbacks share one async signature.

// Bounded, version-aware semantic index repair (server/semantic-index-repair.ts).
// Every scenario runs on SQLite and, when PDPP_TEST_POSTGRES_URL is set, on a
// real Postgres through the same shared engine and the same assertions.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { deleteAllRecordsForConnector, ingestRecord, maintainRecordIndexes } from "../server/records.ts";
import { lockConnectorManifestPublication } from "../server/connector-manifest-write-fence.ts";
import { runRestore } from "../scripts/repair/gmail-delta-blanked-envelope-restore.ts";
import { runRepair } from "../scripts/repair/record-current-projection-repair.ts";
import { reconcileSearchIndexDirtyScope } from "../server/search-index-reconcile.ts";
import {
  computeIndexState,
  configureSemanticBackend,
  createSemanticRepairStore,
  encodeScopeKey,
  makeStubBackend,
  semanticIndexBackfillForManifest,
} from "../server/search-semantic.ts";
import type { RepairFence, RepairStore } from "../server/semantic-index-repair.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CONNECTOR_ID = "semantic-repair";
const INSTANCE_ID = "cin_semantic_repair";
const STREAM = "items";
const TARGET = { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID };
const SUBJECT_SCOPE = encodeScopeKey(STREAM, "subject");

type SemanticFields = readonly string[];

function manifest(fields: SemanticFields = ["subject"], version = "1.0.0") {
  return {
    capabilities: { human_interaction: [] },
    connector_id: CONNECTOR_ID,
    display_name: "Semantic repair fixture",
    manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: STREAM,
        primary_key: ["id"],
        query: { search: { semantic_fields: [...fields] } },
        schema: {
          properties: { body: { type: "string" }, id: { type: "string" }, subject: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version,
  };
}

function pinned(fields: SemanticFields = ["subject"], version = "1.0.0") {
  return { ...manifest(fields, version), storage_binding: { connector_instance_id: INSTANCE_ID } };
}

interface Embedder {
  readonly calls: string[];
  failWith: Error | null;
  hook: ((text: string) => Promise<void>) | null;
}

function installBackend(): Embedder {
  const stub = makeStubBackend({ dimensions: 8 });
  const embedder: Embedder = { calls: [], failWith: null, hook: null };
  configureSemanticBackend({
    ...stub,
    embedDocument: async (text: string) => {
      embedder.calls.push(text);
      if (embedder.failWith) {
        throw embedder.failWith;
      }
      if (embedder.hook) {
        await embedder.hook(text);
      }
      return stub.embedDocument(text);
    },
  });
  return embedder;
}

function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// ─── Backend-neutral fixture access ─────────────────────────────────────────

async function rowsOf(sqliteSql: string, pgSql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  if (isPostgresStorageBackend()) {
    return (await postgresQuery(pgSql, params)).rows as Record<string, unknown>[];
  }
  return getDb()
    .prepare(sqliteSql)
    .all(...params) as Record<string, unknown>[];
}

async function exec(sqliteSql: string, pgSql: string, params: unknown[]): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(pgSql, params);
    return;
  }
  getDb()
    .prepare(sqliteSql)
    .run(...params);
}

interface SemanticRow {
  generation: number | null;
  loc: string;
  recordKey: string;
  scopeKey: string;
  version: number | null;
}

async function semanticRows(): Promise<SemanticRow[]> {
  const rows = await rowsOf(
    `SELECT scope_key, record_key, source_version, source_generation, CAST(rowid AS TEXT) AS loc FROM semantic_search_rowid WHERE connector_instance_id = ?
     UNION ALL
     SELECT scope_key, record_key, source_version, source_generation, CAST(rowid AS TEXT) AS loc FROM semantic_search_blob WHERE connector_instance_id = ?`,
    "SELECT scope_key, record_key, source_version, source_generation, ctid::text AS loc FROM semantic_search_blob WHERE connector_instance_id = $1",
    isPostgresStorageBackend() ? [INSTANCE_ID] : [INSTANCE_ID, INSTANCE_ID]
  );
  return rows
    .map((row) => ({
      generation: row.source_generation === null ? null : Number(row.source_generation),
      loc: String(row.loc),
      recordKey: row.record_key as string,
      scopeKey: row.scope_key as string,
      version: row.source_version === null ? null : Number(row.source_version),
    }))
    .sort((a, b) => (a.scopeKey + a.recordKey).localeCompare(b.scopeKey + b.recordKey));
}

async function rowFor(recordKey: string, scopeKey = SUBJECT_SCOPE): Promise<SemanticRow | undefined> {
  return (await semanticRows()).find((row) => row.recordKey === recordKey && row.scopeKey === scopeKey);
}

async function keys(): Promise<string[]> {
  return (await semanticRows()).filter((row) => row.scopeKey === SUBJECT_SCOPE).map((row) => row.recordKey);
}

async function recordVersion(recordKey: string): Promise<number> {
  const rows = await rowsOf(
    "SELECT version FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?",
    "SELECT version FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
    [INSTANCE_ID, STREAM, recordKey]
  );
  return Number(rows[0]?.version);
}

async function recordSemanticGeneration(recordKey: string): Promise<number> {
  const rows = await rowsOf(
    "SELECT semantic_generation FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?",
    "SELECT semantic_generation FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
    [INSTANCE_ID, STREAM, recordKey]
  );
  return Number(rows[0]?.semantic_generation);
}

async function recordProjection(recordKey: string): Promise<{ cursor: string | null; deleted: boolean; generation: number; version: number }> {
  const rows = await rowsOf(
    "SELECT NULL AS cursor_value, deleted, semantic_generation, version FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?",
    "SELECT cursor_value, deleted, semantic_generation, version FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
    [INSTANCE_ID, STREAM, recordKey]
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`missing fixture record ${recordKey}`);
  }
  return {
    cursor: row.cursor_value === null ? null : String(row.cursor_value),
    deleted: Boolean(row.deleted),
    generation: Number(row.semantic_generation),
    version: Number(row.version),
  };
}

async function streamVersionCounter(): Promise<number> {
  const rows = await rowsOf(
    "SELECT max_version FROM version_counter WHERE connector_instance_id = ? AND stream = ?",
    "SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2",
    [INSTANCE_ID, STREAM]
  );
  return Number(rows[0]?.max_version);
}

async function setStoredVersion(recordKey: string, version: number | null): Promise<void> {
  if (isPostgresStorageBackend()) {
    await exec(
      "",
      "UPDATE semantic_search_blob SET source_version = $3 WHERE connector_instance_id = $1 AND record_key = $2",
      [INSTANCE_ID, recordKey, version]
    );
    return;
  }
  for (const table of ["semantic_search_rowid", "semantic_search_blob"]) {
    getDb()
      .prepare(`UPDATE ${table} SET source_version = ? WHERE connector_instance_id = ? AND record_key = ?`)
      .run(version, INSTANCE_ID, recordKey);
  }
}

async function dirtyRow(): Promise<{ dirty: number; revision: number } | null> {
  const rows = await rowsOf(
    "SELECT dirty, revision FROM search_index_dirty WHERE connector_instance_id = ? AND stream = ?",
    "SELECT dirty, revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
    [INSTANCE_ID, STREAM]
  );
  return rows[0] ? { dirty: Number(rows[0].dirty), revision: Number(rows[0].revision) } : null;
}

async function semanticMeta(): Promise<{ fieldsFingerprint: string; modelId: string } | null> {
  const rows = await rowsOf(
    "SELECT fields_fingerprint, model_id FROM semantic_search_meta WHERE connector_instance_id = ? AND stream = ?",
    "SELECT fields_fingerprint, model_id FROM semantic_search_meta WHERE connector_instance_id = $1 AND stream = $2",
    [INSTANCE_ID, STREAM]
  );
  return rows[0]
    ? { fieldsFingerprint: String(rows[0].fields_fingerprint), modelId: String(rows[0].model_id) }
    : null;
}

async function markDirty(): Promise<void> {
  await exec(
    `INSERT INTO search_index_dirty(connector_instance_id, connector_id, stream, dirty, marked_at, revision)
     VALUES (?, ?, ?, 1, ?, 1)
     ON CONFLICT(connector_instance_id, stream) DO UPDATE SET dirty = 1, marked_at = excluded.marked_at,
       revision = search_index_dirty.revision + 1`,
    `INSERT INTO search_index_dirty(connector_instance_id, connector_id, stream, dirty, marked_at, revision)
     VALUES ($1, $2, $3, 1, $4, 1)
     ON CONFLICT(connector_instance_id, stream) DO UPDATE SET dirty = 1, marked_at = excluded.marked_at,
       revision = search_index_dirty.revision + 1`,
    [INSTANCE_ID, CONNECTOR_ID, STREAM, new Date().toISOString()]
  );
}

/** Test fixture equivalent of an operator repair: same historical version, new provenance generation. */
async function replaceCurrentAtSameVersion(recordKey: string, text: string): Promise<void> {
  const recordJson = JSON.stringify({ id: recordKey, subject: text });
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `UPDATE records SET record_json = $4::jsonb, semantic_generation = nextval('records_semantic_generation_seq')
        WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
      [INSTANCE_ID, STREAM, recordKey, recordJson]
    );
  } else {
    const db = getDb();
    db.transaction(() => {
      const allocated = db.prepare("INSERT INTO semantic_generation_clock DEFAULT VALUES").run().lastInsertRowid;
      db.prepare(
        "UPDATE records SET record_json = ?, semantic_generation = ? WHERE connector_instance_id = ? AND stream = ? AND record_key = ?"
      ).run(recordJson, Number(allocated), INSTANCE_ID, STREAM, recordKey);
    })();
  }
  await markDirty();
}

async function forceLeaseExpired(): Promise<void> {
  await exec(
    "UPDATE semantic_search_backfill_progress SET lease_expires_at = ? WHERE connector_instance_id = ? AND stream = ?",
    "UPDATE semantic_search_backfill_progress SET lease_expires_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint - 1 WHERE connector_instance_id = $1 AND stream = $2",
    isPostgresStorageBackend() ? [INSTANCE_ID, STREAM] : [Date.now() - 1, INSTANCE_ID, STREAM]
  );
}

async function settlesWithin<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

interface ProgressRow {
  cursor: { id?: number; k?: string | null; p: string; s?: number } | null;
  generation: number;
  kind: string;
  owner: string | null;
  passRevision: number | null;
}

async function progressRow(): Promise<ProgressRow | null> {
  const rows = await rowsOf(
    `SELECT pass_kind, cursor_key, pass_dirty_revision, lease_owner, lease_generation
       FROM semantic_search_backfill_progress WHERE connector_instance_id = ? AND stream = ?`,
    `SELECT pass_kind, cursor_key, pass_dirty_revision, lease_owner, lease_generation
       FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 AND stream = $2`,
    [INSTANCE_ID, STREAM]
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    cursor: row.cursor_key ? JSON.parse(row.cursor_key as string) : null,
    generation: Number(row.lease_generation),
    kind: row.pass_kind as string,
    owner: (row.lease_owner as string | null) ?? null,
    passRevision: row.pass_dirty_revision === null ? null : Number(row.pass_dirty_revision),
  };
}

function subject(key: string, text: string) {
  return { data: { id: key, subject: text }, emitted_at: "2026-10-14T00:00:00.000Z", key, stream: STREAM };
}

/** Durable write only (no derived index work), like a crash before publish. */
async function ingest(key: string, text: string): Promise<number> {
  await ingestRecord(TARGET, subject(key, text), { deferIndexes: true });
  return await recordVersion(key);
}

/** Live publish of the record's CURRENT version, exactly like the post-ack lane. */
async function publish(key: string, text: string): Promise<void> {
  await maintainRecordIndexes(
    TARGET,
    subject(key, text),
    await recordVersion(key),
    {},
    undefined,
    await recordSemanticGeneration(key)
  );
}

async function remove(key: string): Promise<void> {
  const envelope = { emitted_at: "2026-10-14T00:00:01.000Z", key, op: "delete" as const, stream: STREAM };
  await ingestRecord(TARGET, envelope, { deferIndexes: true });
  await maintainRecordIndexes(TARGET, envelope, await recordVersion(key), {});
}

interface SpyStore extends RepairStore {
  readonly calls: string[];
  readonly fences: RepairFence[];
}

function spyStore(options: { leaseTtlMs?: number; noRelease?: boolean } = {}): SpyStore {
  const inner = createSemanticRepairStore(options);
  const calls: string[] = [];
  const fences: RepairFence[] = [];
  return {
    ...inner,
    acquire: async (args) => {
      calls.push("acquire");
      const result = await inner.acquire(args);
      if (!result.busy) {
        fences.push(result.fence);
      }
      return result;
    },
    calls,
    deleteStreamRows: (scope, fence) => {
      calls.push("deleteStreamRows");
      return inner.deleteStreamRows(scope, fence);
    },
    resetIdentityPass: (scope, fence, args) => {
      calls.push("resetIdentityPass");
      return inner.resetIdentityPass(scope, fence, args);
    },
    fences,
    release: (scope, fence) => (options.noRelease ? Promise.resolve() : inner.release(scope, fence)),
  };
}

type RepairOptions = NonNullable<NonNullable<Parameters<typeof semanticIndexBackfillForManifest>[0]>["repair"]>;

async function backfill(repair: RepairOptions = {}, fields: SemanticFields = ["subject"]) {
  return await semanticIndexBackfillForManifest({ manifest: pinned(fields) as never, repair });
}

async function statuses(repair: RepairOptions = {}, fields: SemanticFields = ["subject"]): Promise<string[]> {
  return (await backfill(repair, fields)).scopes.map((scope) => scope.status);
}

async function setup(fields: SemanticFields = ["subject"]): Promise<Embedder> {
  const embedder = installBackend();
  await registerConnector(manifest(fields), { backfillRetrievalIndexes: false });
  return embedder;
}

/** Run one scenario on SQLite and (when configured) Postgres. */
function scenario(name: string, run: () => Promise<void>) {
  test(`SQLite: ${name}`, async () => {
    initDb(":memory:");
    try {
      await run();
    } finally {
      configureSemanticBackend(null);
      closeDb();
    }
  });
  test(`PostgreSQL: ${name}`, { skip: !POSTGRES_URL }, async () => {
    assert.ok(POSTGRES_URL);
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_test_semrepair_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}_1`,
        templateName: null,
      },
      async (databaseUrl) => {
        initDb(":memory:");
        try {
          await initPostgresStorage({ backend: "postgres", databaseUrl });
          await run();
        } finally {
          configureSemanticBackend(null);
          await closePostgresStorage();
          closeDb();
        }
      }
    );
  });
}

// ─── Required behaviors ─────────────────────────────────────────────────────

scenario(
  "a stale update (embed failed at publish) is repaired in place; count drift never deletes the stream",
  async () => {
    const embedder = await setup();
    await ingest("k1", "first text");
    await publish("k1", "first text");
    await ingest("k2", "second text");
    await publish("k2", "second text");
    assert.equal((await rowFor("k1"))?.version, 1);
    // Same key, new version; the live publish is skipped (backend down) so the row is stale, count unchanged.
    configureSemanticBackend(null);
    await ingest("k1", "first text, edited");
    await publish("k1", "first text, edited");
    const k2Before = await rowFor("k2");
    const embedder2 = installBackend();
    const store = spyStore();
    assert.deepEqual(await statuses({ store }), ["complete"]);
    assert.equal((await rowFor("k1"))?.version, await recordVersion("k1"), "k1 now carries its record version");
    assert.deepEqual(embedder2.calls, ["first text, edited"], "only the stale row is re-embedded");
    assert.deepEqual(await rowFor("k2"), k2Before, "the current row is untouched (same physical row)");
    assert.equal(
      store.calls.includes("deleteStreamRows"),
      false,
      "count drift/staleness never issues the whole-stream delete"
    );
    assert.equal(embedder.calls.length, 2);
  }
);

scenario("missing + orphan rows that offset to equal counts are both detected and repaired", async () => {
  await setup();
  await ingest("a", "alpha");
  await publish("a", "alpha");
  await ingest("b", "bravo");
  await publish("b", "bravo");
  configureSemanticBackend(null); // backend unavailable
  await remove("a"); // delete skipped: orphan row for a
  await ingest("c", "charlie"); // missing row for c
  await publish("c", "charlie");
  assert.deepEqual(await keys(), ["a", "b"], "2 rows == 2 live records: the old count gate sees 'in sync'");
  const embedder = installBackend();
  const store = spyStore();
  assert.deepEqual(await statuses({ store }), ["complete"]);
  assert.deepEqual(await keys(), ["b", "c"]);
  assert.deepEqual(embedder.calls, ["charlie"]);
  assert.equal((await rowFor("c"))?.version, await recordVersion("c"));
  assert.equal(store.calls.includes("deleteStreamRows"), false);
});

scenario("legacy NULL rows are stale: re-embedded and stamped only after validation", async () => {
  await setup();
  await ingest("k1", "legacy text");
  await publish("k1", "legacy text");
  await setStoredVersion("k1", null);
  const embedder = installBackend();
  // A failing backend must not stamp anything current.
  embedder.failWith = new Error("backend down");
  await assert.rejects(backfill(), /backend down/);
  assert.equal((await rowFor("k1"))?.version, null, "nothing is marked current without a re-embed");
  embedder.failWith = null;
  assert.deepEqual(await statuses(), ["complete"]);
  assert.equal((await rowFor("k1"))?.version, await recordVersion("k1"));
  assert.deepEqual(embedder.calls, ["legacy text", "legacy text"]);
});

scenario(
  "backend unavailable, then a delete, then the backend returns: the orphan goes and nothing is falsely current",
  async () => {
    await setup();
    await ingest("k1", "one");
    await publish("k1", "one");
    await ingest("k2", "two");
    await publish("k2", "two");
    configureSemanticBackend(null);
    assert.deepEqual(await statuses(), []);
    await remove("k1");
    assert.deepEqual(await keys(), ["k1", "k2"], "the delete was skipped");
    const embedder = installBackend();
    embedder.failWith = new Error("warming up");
    await ingest("k3", "three");
    await assert.rejects(backfill(), /warming up/);
    assert.equal(await rowFor("k3"), undefined, "no row was invented for k3");
    assert.equal((await dirtyRow())?.dirty, 1);
    embedder.failWith = null;
    assert.deepEqual(await statuses(), ["complete"]);
    assert.deepEqual(await keys(), ["k2", "k3"]);
    assert.equal((await dirtyRow())?.dirty, 0);
  }
);

scenario("two overlapping passes on one scope: one is busy and the dirty mark survives", async () => {
  const embedder = await setup();
  await ingest("k1", "blocked text");
  const entered = deferred();
  const release = deferred();
  embedder.hook = async (text) => {
    if (text === "blocked text") {
      entered.release();
      await release.promise;
    }
  };
  const first = backfill();
  await entered.promise;
  const before = await dirtyRow();
  assert.equal(before?.dirty, 1);
  const second = await backfill();
  assert.deepEqual(
    second.scopes.map((scope) => scope.status),
    ["busy"]
  );
  assert.deepEqual(await dirtyRow(), before, "busy neither clears nor changes the revision");
  assert.equal(embedder.calls.length, 1, "the busy call did no embedding work");
  release.release();
  assert.deepEqual(
    (await first).scopes.map((scope) => scope.status),
    ["complete"]
  );
  assert.equal((await dirtyRow())?.dirty, 0);
});

scenario("an ingest version update racing a repair page: the newer version wins and nothing older lands", async () => {
  const embedder = await setup();
  await ingest("k1", "old text");
  const entered = deferred();
  const release = deferred();
  embedder.hook = async (text) => {
    if (text === "old text") {
      entered.release();
      await release.promise;
    }
  };
  const repairing = backfill();
  await entered.promise;
  // New record version AND its publisher land while the repair holds an embedding of the old text.
  const newVersion = await ingest("k1", "new text");
  await publish("k1", "new text");
  assert.equal((await rowFor("k1"))?.version, newVersion);
  release.release();
  await repairing;
  const row = await rowFor("k1");
  assert.equal(row?.version, newVersion, "the older version did not overwrite the newer row");
  assert.equal(await recordVersion("k1"), newVersion);
  // Whatever the first call decided, the next converges with the NEW text only.
  await backfill();
  assert.equal((await rowFor("k1"))?.version, newVersion);
});

scenario("the budget stops mid-stream and the next call resumes from the persisted cursor", async () => {
  const embedder = await setup();
  for (const key of ["k1", "k2", "k3", "k4", "k5"]) {
    await ingest(key, `text ${key}`);
  }
  const first = await backfill({ maxPages: 1, pageSize: 2 });
  assert.deepEqual(
    first.scopes.map((scope) => scope.status),
    ["partial"]
  );
  assert.deepEqual(await keys(), ["k1", "k2"]);
  const saved = await progressRow();
  assert.equal(saved?.cursor?.p, "records");
  assert.equal(saved?.owner, null, "partial releases the lease");
  assert.equal((await dirtyRow())?.dirty, 1, "partial keeps the scope dirty");
  const passRevision = saved?.passRevision;
  const second = await backfill({ maxPages: 1, pageSize: 2 });
  assert.deepEqual(
    second.scopes.map((scope) => scope.status),
    ["partial"]
  );
  assert.deepEqual(await keys(), ["k1", "k2", "k3", "k4"], "the second call started after the saved cursor");
  assert.equal((await progressRow())?.passRevision, passRevision, "pass_dirty_revision is not re-read on resume");
  assert.equal(await computeIndexState(), "stale", "an unfinished pass keeps the existing 'stale' advertisement");
  assert.deepEqual(await statuses({ pageSize: 2 }), ["complete"]);
  assert.deepEqual(
    [...embedder.calls].sort(),
    ["text k1", "text k2", "text k3", "text k4", "text k5"],
    "no page was embedded twice"
  );
  assert.equal(await progressRow(), null);
  assert.equal((await dirtyRow())?.dirty, 0);
  assert.equal(await computeIndexState(), "built");
});

scenario("an unchanged repair writes nothing (same physical rows, no re-embedding)", async () => {
  const embedder = await setup();
  await ingest("k1", "stable one");
  await publish("k1", "stable one");
  await ingest("k2", "stable two");
  await publish("k2", "stable two");
  const before = await semanticRows();
  const calls = embedder.calls.length;
  assert.deepEqual(await statuses(), ["complete"]);
  assert.deepEqual(await semanticRows(), before, "no row moved");
  assert.equal(embedder.calls.length, calls, "nothing was re-embedded");
  if (isPostgresStorageBackend()) {
    // The Postgres publisher also elides an identical write. (The SQLite
    // publisher is delete + insert by design and has no elision requirement.)
    await publish("k1", "stable one");
    assert.deepEqual(await semanticRows(), before);
  }
});

scenario("a record version that is LOWER than a pre-existing higher stored version is repaired", async () => {
  await setup();
  await ingest("k1", "regenerated text");
  await publish("k1", "regenerated text");
  const version = await recordVersion("k1");
  await setStoredVersion("k1", version + 40); // stream regenerated; stored embedding claims a higher version
  const embedder = installBackend();
  assert.deepEqual(await statuses(), ["complete"]);
  assert.equal((await rowFor("k1"))?.version, version, "the higher stored version did not block the repair");
  assert.deepEqual(embedder.calls, ["regenerated text"]);
});

scenario("a stream reset while the backend is down leaves no row that could look current", async () => {
  await setup();
  await ingest("k1", "before reset");
  await publish("k1", "before reset");
  assert.equal((await rowFor("k1"))?.version, 1);
  configureSemanticBackend(null);
  await deleteAllRecordsForConnector(CONNECTOR_ID, new Set([INSTANCE_ID]));
  assert.deepEqual(await keys(), [], "reset removes derived rows even with no backend");
  // Regenerated stream: versions restart at 1 with different text.
  assert.equal(await ingest("k1", "after reset"), 1);
  const embedder = installBackend();
  assert.deepEqual(await statuses(), ["complete"]);
  assert.deepEqual(embedder.calls, ["after reset"]);
  assert.equal((await rowFor("k1"))?.version, 1);
});

scenario("an emptied field removes its stale row", async () => {
  await setup(["subject", "body"]);
  await ingestRecord(
    TARGET,
    {
      data: { body: "kept body", id: "k1", subject: "doomed subject" },
      emitted_at: "2026-10-14T00:00:00.000Z",
      key: "k1",
      stream: STREAM,
    },
    { deferIndexes: true }
  );
  await semanticIndexBackfillForManifest({ manifest: pinned(["subject", "body"]) as never });
  assert.equal((await semanticRows()).length, 2);
  await ingestRecord(
    TARGET,
    { data: { body: "kept body", id: "k1" }, emitted_at: "2026-10-14T00:00:02.000Z", key: "k1", stream: STREAM },
    { deferIndexes: true }
  );
  await semanticIndexBackfillForManifest({ manifest: pinned(["subject", "body"]) as never });
  assert.deepEqual(
    (await semanticRows()).map((row) => row.scopeKey),
    [encodeScopeKey(STREAM, "body")]
  );
});

// ─── Rev 3 gate: dirty-CAS revision is captured at the START of the whole pass ──

scenario(
  "GATE 1: a key behind the saved cursor changes between ticks; the dirty mark survives and a new pass repairs it",
  async () => {
    await setup();
    for (const key of ["k1", "k2", "k3", "k4"]) {
      await ingest(key, `v1 ${key}`);
    }
    assert.deepEqual(await statuses({ maxPages: 1, pageSize: 2 }), ["partial"]);
    const startRevision = (await progressRow())?.passRevision;
    assert.ok(startRevision);
    // k1 is behind the cursor. Its change bumps the dirty revision.
    const k1Version = await ingest("k1", "v2 k1");
    const bumped = await dirtyRow();
    assert.ok(bumped && bumped.revision > startRevision);
    assert.deepEqual(await statuses({ pageSize: 2 }), ["partial"], "the pass reaches its end but must NOT clear");
    assert.deepEqual(await dirtyRow(), { dirty: 1, revision: bumped.revision }, "dirty mark and revision survive");
    assert.notEqual((await rowFor("k1"))?.version, k1Version, "the behind-cursor change was not seen by this pass");
    const restarted = await progressRow();
    assert.equal(restarted?.cursor, null, "a new pass starts at the beginning");
    assert.equal(restarted?.passRevision, bumped.revision, "with a fresh pass_dirty_revision");
    assert.deepEqual(await statuses({ pageSize: 2 }), ["complete"]);
    assert.equal((await rowFor("k1"))?.version, k1Version, "the new pass repaired the key");
    assert.equal((await dirtyRow())?.dirty, 0);
  }
);

scenario("GATE 2: the same across a lease takeover by a new owner; pass_dirty_revision is never re-read", async () => {
  const embedder = await setup();
  for (const key of ["k1", "k2", "k3", "k4"]) {
    await ingest(key, `v1 ${key}`);
  }
  // Owner A: crashes after page 1 (lease left held, cursor + revision persisted).
  const ownerA = spyStore({ leaseTtlMs: 1500, noRelease: true });
  embedder.hook = async (text) => {
    if (text === "v1 k3") {
      throw new Error("owner A crashed");
    }
  };
  await assert.rejects(backfill({ pageSize: 2, store: ownerA }), /owner A crashed/);
  embedder.hook = null;
  const crashed = await progressRow();
  assert.ok(crashed?.owner, "owner A's lease is still held");
  assert.equal(crashed?.cursor?.p, "records");
  const startRevision = crashed?.passRevision;
  assert.ok(startRevision);
  const k1Version = await ingest("k1", "v2 k1"); // behind the cursor; bumps revision
  const bumped = (await dirtyRow())?.revision as number;
  assert.ok(bumped > startRevision);
  // While A's lease is live, a new owner is busy.
  assert.deepEqual(await statuses({ pageSize: 2 }), ["busy"]);
  await new Promise((resolve) => setTimeout(resolve, 1700)); // A's lease expires
  const ownerB = spyStore();
  assert.deepEqual(
    await statuses({ pageSize: 2, store: ownerB }),
    ["partial"],
    "B takes over, finishes, and must not clear"
  );
  assert.deepEqual(await dirtyRow(), { dirty: 1, revision: bumped });
  const afterB = await progressRow();
  assert.equal(afterB?.generation, 2, "B holds a newer fencing generation");
  assert.equal(
    afterB?.passRevision,
    bumped,
    "B reset to a fresh pass only because the CAS failed, with the CURRENT revision"
  );
  // The old owner is fenced: it can neither save a cursor, write, nor complete.
  const [fenceA] = ownerA.fences;
  assert.ok(fenceA);
  const scope = { connectorId: CONNECTOR_ID, connectorInstanceId: INSTANCE_ID, stream: STREAM };
  const store = createSemanticRepairStore();
  assert.equal(await store.saveCursor(scope, fenceA, { id: 99, p: "records" }), false);
  assert.equal(
    await store.writeEntries(scope, fenceA, [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: INSTANCE_ID,
        recordKey: "k1",
        scopeKey: SUBJECT_SCOPE,
        vector: new Float32Array(8).fill(0.5),
        version: 1,
      },
    ]),
    false
  );
  assert.equal(await store.complete(scope, fenceA), "lost");
  assert.deepEqual(await statuses({ pageSize: 2 }), ["complete"]);
  assert.equal((await rowFor("k1"))?.version, k1Version);
});

scenario("GATE 3: a new orphan behind the orphan cursor is removed by the next pass", async () => {
  await setup();
  for (const key of ["k1", "k2", "k3"]) {
    await ingest(key, `text ${key}`);
    await publish(key, `text ${key}`);
  }
  // Pages: records[k1,k2], records[k3] (short -> orphans), orphans[k1,k2] -> cursor k2.
  assert.deepEqual(await statuses({ maxPages: 3, pageSize: 2 }), ["partial"]);
  const mid = await progressRow();
  assert.equal(mid?.cursor?.p, "orphans");
  assert.equal(mid?.cursor?.k, "k2");
  configureSemanticBackend(null);
  await remove("k1"); // new orphan BEHIND the orphan cursor
  installBackend();
  assert.deepEqual(await statuses({ pageSize: 2 }), ["partial"], "the pass ends but its revision is stale: no clear");
  assert.equal((await dirtyRow())?.dirty, 1);
  assert.deepEqual(await keys(), ["k1", "k2", "k3"], "the orphan sits behind this pass's cursor");
  assert.deepEqual(await statuses({ pageSize: 2 }), ["complete"]);
  assert.deepEqual(await keys(), ["k2", "k3"]);
  assert.equal((await dirtyRow())?.dirty, 0);
});

scenario(
  "GATE 4: a profile change mid-pass resets the pass (cursor and pass_dirty_revision) with the whole-stream rebuild",
  async () => {
    await setup();
    for (const key of ["k1", "k2", "k3"]) {
      await ingest(key, `text ${key}`);
    }
    assert.deepEqual(await statuses(), ["complete"], "establish the identity (meta) first");
    await ingest("k4", "text k4");
    assert.deepEqual(await statuses({ maxPages: 2, pageSize: 1 }), ["partial"]);
    const mid = await progressRow();
    assert.equal(mid?.kind, "repair");
    assert.equal(mid?.cursor?.p, "records");
    const midId = mid?.cursor?.id as number;
    const firstRevision = mid?.passRevision as number;
    await ingest("k5", "text k5"); // bumps the dirty revision
    const bumped = (await dirtyRow())?.revision as number;
    assert.ok(bumped > firstRevision);
    // Declare a second field: the fields fingerprint changes.
    await registerConnector(manifest(["subject", "body"], "2.0.0"), { backfillRetrievalIndexes: false });
    const store = spyStore();
    assert.deepEqual(await statuses({ maxPages: 1, pageSize: 1, store }, ["subject", "body"]), ["partial"]);
    assert.equal(
      store.calls.filter((call) => call === "resetIdentityPass").length,
      1,
      "identity change is the only whole-stream delete"
    );
    const reset = await progressRow();
    assert.equal(reset?.kind, "rebuild");
    assert.equal(reset?.passRevision, bumped, "pass_dirty_revision was reset to the current revision");
    assert.ok((reset?.cursor?.id as number) < midId, "the cursor restarted at the first record");
    assert.deepEqual(await keys(), ["k1"], "old rows were dropped; the new pass has only covered the first record");
    assert.equal(await computeIndexState(), "stale");
    assert.deepEqual(await statuses({ pageSize: 1, store }, ["subject", "body"]), ["complete"]);
    assert.equal(
      store.calls.filter((call) => call === "resetIdentityPass").length,
      1,
      "the resumed rebuild does not delete again"
    );
    assert.deepEqual(await keys(), ["k1", "k2", "k3", "k4", "k5"]);
  }
);

// ─── Pins, fairness, enqueue ────────────────────────────────────────────────

scenario("storage_binding pins one physical instance; an unpinned call still covers every instance", async () => {
  await setup();
  const other = { connector_id: CONNECTOR_ID, connector_instance_id: "cin_semantic_repair_other" };
  await ingest("k1", "mine");
  await ingestRecord(other, subject("k1", "theirs"), { deferIndexes: true });
  const result = await backfill();
  assert.deepEqual(
    result.scopes.map((scope) => scope.connectorInstanceId),
    [INSTANCE_ID]
  );
  const unpinned = await semanticIndexBackfillForManifest({ manifest: manifest() as never });
  assert.deepEqual(
    unpinned.scopes.map((scope) => scope.connectorInstanceId).sort(),
    [INSTANCE_ID, "cin_semantic_repair_other"].sort()
  );
});

scenario("a scope deferred by an exhausted budget is enqueued dirty with an unchanged revision", async () => {
  await setup();
  await ingest("k1", "text");
  const revision = (await dirtyRow())?.revision;
  await exec(
    "UPDATE search_index_dirty SET dirty = 0 WHERE connector_instance_id = ?",
    "UPDATE search_index_dirty SET dirty = 0 WHERE connector_instance_id = $1",
    [INSTANCE_ID]
  );
  assert.deepEqual(await statuses({ maxPages: 0 }), ["partial"]);
  assert.deepEqual(await dirtyRow(), { dirty: 1, revision: revision as number });
  assert.equal(await progressRow(), null, "nothing was started");
});

scenario(
  "the reconcile reports busy/partial without clearing, rotates partial scopes, and converges when done",
  async () => {
    await setup();
    for (const key of ["k1", "k2", "k3"]) {
      await ingest(key, `text ${key}`);
    }
    const listed = async () => {
      const row = (
        await rowsOf(
          "SELECT revision, marked_at, connector_id FROM search_index_dirty WHERE connector_instance_id = ? AND stream = ?",
          "SELECT revision, marked_at, connector_id FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
          [INSTANCE_ID, STREAM]
        )
      )[0] as { connector_id: string; marked_at: string; revision: number };
      return {
        connectorId: row.connector_id,
        connectorInstanceId: INSTANCE_ID,
        markedAt: row.marked_at,
        revision: Number(row.revision),
        stream: STREAM,
      };
    };
    const scope = await listed();
    // An already-expired caller deadline defers the scope: partial, still dirty, no pass started.
    const partial = await reconcileSearchIndexDirtyScope(scope, undefined, Date.now() - 1);
    assert.equal(partial.outcome, "partial");
    const after = await listed();
    assert.equal(after.revision, scope.revision, "partial never touches the revision");
    assert.equal((await dirtyRow())?.dirty, 1);
    const done = await reconcileSearchIndexDirtyScope(after);
    assert.equal(done.outcome, "converged");
    assert.equal((await dirtyRow())?.dirty, 0);
  }
);

// ─── Adversarial provenance, publication, and completion proofs ────────────

scenario("operator repairs enqueue durable work and the next pass converges on the repaired provenance", async () => {
  await setup();
  await ingest("projection", "authoritative subject");
  await publish("projection", "authoritative subject");
  const beforeProjection = await dirtyRow();

  if (isPostgresStorageBackend()) {
    // This is the real projection-repair utility, not a copied SQL fragment.
    await postgresQuery(
      "UPDATE records SET record_json = $4::jsonb WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
      [INSTANCE_ID, STREAM, "projection", JSON.stringify({ id: "projection", subject: "corrupt current projection" })]
    );
    const repaired = await runRepair({
      apply: true,
      applyDeletes: false,
      connectorInstanceId: INSTANCE_ID,
      limit: null,
      pool: getPostgresPool(),
      recordKey: "projection",
      stamp: "semantic_adversarial_projection",
      stream: STREAM,
    });
    assert.equal(repaired.failed, false);
    assert.equal(repaired.affected.updated, 1);

    // Gmail's tool is intentionally Postgres-only. Exercise its exported
    // implementation against its real `messages` scope and assert its durable
    // enqueue before switching back to the semantic fixture stream.
    const gmailStream = "messages";
    const gmailManifest = {
      ...manifest(["subject"], "gmail"),
      streams: [{ ...manifest(["subject"], "gmail").streams[0], name: gmailStream }],
    };
    await registerConnector(gmailManifest, { backfillRetrievalIndexes: false });
    await ingestRecord(
      TARGET,
      {
        data: { from_email: "sender@example.test", id: "gmail", subject: "mail subject" },
        emitted_at: "2026-10-14T00:00:00.000Z",
        key: "gmail",
        stream: gmailStream,
      },
      { deferIndexes: true }
    );
    await postgresQuery(
      "UPDATE records SET record_json = jsonb_build_object('id', $3) WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
      [INSTANCE_ID, gmailStream, "gmail"]
    );
    const gmailBefore = await rowsOf(
      "",
      "SELECT revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [INSTANCE_ID, gmailStream]
    );
    const restored = await runRestore({
      apply: true,
      connectorInstanceId: INSTANCE_ID,
      pool: getPostgresPool(),
      stamp: "semantic_adversarial_gmail",
    });
    assert.equal(restored.failed, false);
    assert.equal(restored.restoredCount, 1);
    const gmailAfter = await rowsOf(
      "",
      "SELECT dirty, revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [INSTANCE_ID, gmailStream]
    );
    assert.equal(Number(gmailAfter[0]?.dirty), 1);
    assert.ok(Number(gmailAfter[0]?.revision) > Number(gmailBefore[0]?.revision));
    await semanticIndexBackfillForManifest({
      manifest: { ...gmailManifest, storage_binding: { connector_instance_id: INSTANCE_ID } } as never,
    });
    const gmailRows = await rowsOf(
      "",
      "SELECT b.source_version, b.source_generation, r.version, r.semantic_generation FROM semantic_search_blob b JOIN records r ON r.connector_instance_id = b.connector_instance_id AND r.record_key = b.record_key WHERE b.connector_instance_id = $1 AND b.scope_key = $2 AND b.record_key = $3",
      [INSTANCE_ID, encodeScopeKey(gmailStream, "subject"), "gmail"]
    );
    assert.deepEqual(gmailRows[0], {
      semantic_generation: gmailRows[0]?.source_generation,
      source_generation: gmailRows[0]?.source_generation,
      source_version: gmailRows[0]?.version,
      version: gmailRows[0]?.version,
    });
    await registerConnector(manifest(), { backfillRetrievalIndexes: false });
  } else {
    // The utilities are Postgres-only. The SQLite half proves the same durable
    // current-row provenance contract through the backend's transaction path.
    await replaceCurrentAtSameVersion("projection", "authoritative subject");
  }

  const afterProjection = await dirtyRow();
  assert.ok(afterProjection && beforeProjection && afterProjection.revision > beforeProjection.revision);
  const calls = installBackend();
  await backfill();
  assert.deepEqual(calls.calls, ["authoritative subject"]);
  const semantic = await rowFor("projection");
  assert.equal(semantic?.version, await recordVersion("projection"));
  assert.equal(semantic?.generation, await recordSemanticGeneration("projection"));
  assert.equal((await dirtyRow())?.dirty, 0);
});

scenario("same-version projection restore and tombstone advance only semantic provenance and dirty revision", async () => {
  await setup();
  await ingest("k1", "authoritative");
  await publish("k1", "authoritative");
  const original = await recordProjection("k1");
  const counter = await streamVersionCounter();
  const dirtyBefore = (await dirtyRow())?.revision as number;

  if (isPostgresStorageBackend()) {
    await postgresQuery(
      "UPDATE records SET record_json = $4::jsonb WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
      [INSTANCE_ID, STREAM, "k1", JSON.stringify({ id: "k1", subject: "wrong" })]
    );
    const repaired = await runRepair({
      apply: true,
      applyDeletes: false,
      connectorInstanceId: INSTANCE_ID,
      limit: null,
      pool: getPostgresPool(),
      recordKey: "k1",
      stamp: "semantic_same_version_restore",
      stream: STREAM,
    });
    assert.equal(repaired.failed, false);
  } else {
    await replaceCurrentAtSameVersion("k1", "authoritative");
  }
  const restored = await recordProjection("k1");
  assert.deepEqual(
    { cursor: restored.cursor, version: restored.version },
    { cursor: original.cursor, version: original.version }
  );
  assert.equal(await streamVersionCounter(), counter);
  assert.ok(restored.generation > original.generation);
  assert.ok(((await dirtyRow())?.revision as number) > dirtyBefore);

  const dirtyAfterRestore = (await dirtyRow())?.revision as number;
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      "UPDATE record_changes SET deleted = TRUE, deleted_at = emitted_at WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
      [INSTANCE_ID, STREAM, "k1"]
    );
    const tombstoned = await runRepair({
      apply: true,
      applyDeletes: true,
      connectorInstanceId: INSTANCE_ID,
      limit: null,
      pool: getPostgresPool(),
      recordKey: "k1",
      stamp: "semantic_same_version_tombstone",
      stream: STREAM,
    });
    assert.equal(tombstoned.failed, false);
    assert.equal(tombstoned.affected.deleted, 1);
  } else {
    const db = getDb();
    db.transaction(() => {
      const generation = Number(db.prepare("INSERT INTO semantic_generation_clock DEFAULT VALUES").run().lastInsertRowid);
      db.prepare("UPDATE records SET deleted = 1, semantic_generation = ? WHERE connector_instance_id = ? AND stream = ? AND record_key = ?").run(
        generation,
        INSTANCE_ID,
        STREAM,
        "k1"
      );
    })();
    await markDirty();
  }
  const tombstone = await recordProjection("k1");
  assert.equal(tombstone.deleted, true);
  assert.deepEqual(
    { cursor: tombstone.cursor, version: tombstone.version },
    { cursor: original.cursor, version: original.version }
  );
  assert.equal(await streamVersionCounter(), counter);
  assert.ok(tombstone.generation > restored.generation);
  assert.ok(((await dirtyRow())?.revision as number) > dirtyAfterRestore);
});

scenario("an old publisher computed before a same-version repair cannot overwrite the repaired generation", async () => {
  const embedder = await setup();
  await ingest("k1", "old text");
  await publish("k1", "old text");
  const oldGeneration = await recordSemanticGeneration("k1");
  const entered = deferred();
  const release = deferred();
  embedder.hook = async (text) => {
    if (text === "old text") {
      entered.release();
      await release.promise;
    }
  };
  const oldPublisher = publish("k1", "old text");
  await entered.promise;
  await replaceCurrentAtSameVersion("k1", "new text");
  const newGeneration = await recordSemanticGeneration("k1");
  assert.ok(newGeneration > oldGeneration);
  embedder.hook = null;
  await backfill();
  assert.equal((await rowFor("k1"))?.generation, newGeneration);
  release.release();
  await oldPublisher;
  assert.equal((await rowFor("k1"))?.generation, newGeneration);
  assert.equal((await rowFor("k1"))?.version, await recordVersion("k1"));
});

scenario("a delete then projection reinsert at the same version cannot ABA-match an old computation", async () => {
  const embedder = await setup();
  await ingest("k1", "old text");
  await publish("k1", "old text");
  const old = await recordProjection("k1");
  const entered = deferred();
  const release = deferred();
  embedder.hook = async (text) => {
    if (text === "old text") {
      entered.release();
      await release.promise;
    }
  };
  const stalePublisher = publish("k1", "old text");
  await entered.promise;

  if (isPostgresStorageBackend()) {
    await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3", [INSTANCE_ID, STREAM, "k1"]);
    const reinserted = await runRepair({
      apply: true,
      applyDeletes: false,
      connectorInstanceId: INSTANCE_ID,
      limit: null,
      pool: getPostgresPool(),
      recordKey: "k1",
      stamp: "semantic_aba_projection_insert",
      stream: STREAM,
    });
    assert.equal(reinserted.failed, false);
    assert.equal(reinserted.affected.inserted, 1);
  } else {
    const db = getDb();
    const row = db
      .prepare("SELECT connector_id, record_json, emitted_at, version FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?")
      .get(INSTANCE_ID, STREAM, "k1") as Record<string, unknown>;
    db.transaction(() => {
      db.prepare("DELETE FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?").run(INSTANCE_ID, STREAM, "k1");
      const generation = Number(db.prepare("INSERT INTO semantic_generation_clock DEFAULT VALUES").run().lastInsertRowid);
      db.prepare(
        "INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, semantic_generation, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)"
      ).run(row.connector_id, INSTANCE_ID, STREAM, "k1", row.record_json, row.emitted_at, row.version, generation);
    })();
    await markDirty();
  }
  const reinserted = await recordProjection("k1");
  assert.equal(reinserted.version, old.version);
  assert.ok(reinserted.generation > old.generation);
  embedder.hook = null;
  await backfill();
  release.release();
  await stalePublisher;
  assert.equal((await rowFor("k1"))?.generation, reinserted.generation);
});

scenario("an old identity reset cannot delete a newly published profile, and publication lock users settle", async () => {
  await setup();
  await ingest("k1", "stable");
  await publish("k1", "stable");
  await backfill();
  const preserved = await semanticRows();
  await registerConnector(manifest(["subject", "body"], "two"), { backfillRetrievalIndexes: false });

  const inner = createSemanticRepairStore();
  const resetEntered = deferred();
  const releaseReset = deferred();
  const pausingStore: RepairStore = {
    ...inner,
    resetIdentityPass: async (...args) => {
      resetEntered.release();
      await releaseReset.promise;
      return await inner.resetIdentityPass(...args);
    },
  };
  const oldReset = semanticIndexBackfillForManifest({
    manifest: pinned(["subject", "body"], "two") as never,
    repair: { store: pausingStore },
  });
  await resetEntered.promise;

  // The profile publication completes before the old caller crosses the
  // destructive transition. Its expected stream subset is now obsolete.
  await registerConnector(manifest(["subject", "body", "id"], "three"), { backfillRetrievalIndexes: false });
  releaseReset.release();
  await assert.rejects(oldReset, /manifest revision changed/);
  assert.deepEqual(await semanticRows(), preserved, "the stale reset did not delete the current derived stream");

  if (isPostgresStorageBackend()) {
    // Hold the shared publication serialization key, then start a publisher
    // and a lease claimant. Releasing it lets both settle under a bounded wait:
    // there is no lock cycle between profile publication, lease, and publisher.
    const locked = deferred();
    const unlock = deferred();
    const holder = withPostgresTransaction(async (client) => {
      await lockConnectorManifestPublication(client, CONNECTOR_ID);
      locked.release();
      await unlock.promise;
    });
    await locked.promise;
    const publisher = publish("k1", "stable");
    const claimant = inner.acquire({
      identity: { dimensions: 8, distanceMetric: "cosine", fieldsFingerprint: "lock", modelId: "lock" },
      owner: "publication-lock-claimant",
      scope: { connectorId: CONNECTOR_ID, connectorInstanceId: INSTANCE_ID, stream: STREAM },
    });
    unlock.release();
    await settlesWithin(Promise.all([holder, publisher, claimant]), "publication lock ordering");
  }
});

scenario("stale completion cannot publish metadata or clear dirty work after publication or lease takeover", async () => {
  await setup();
  await ingest("k1", "text");
  await backfill();
  const baselineMeta = await semanticMeta();
  assert.ok(baselineMeta);
  await registerConnector(manifest(["subject", "body"], "two"), { backfillRetrievalIndexes: false });

  const inner = createSemanticRepairStore({ leaseTtlMs: 60_000 });
  const completionEntered = deferred();
  const releaseCompletion = deferred();
  const pausingStore: RepairStore = {
    ...inner,
    complete: async (...args) => {
      completionEntered.release();
      await releaseCompletion.promise;
      return await inner.complete(...args);
    },
  };
  const oldCompletion = semanticIndexBackfillForManifest({
    manifest: pinned(["subject", "body"], "two") as never,
    repair: { store: pausingStore },
  });
  await completionEntered.promise;
  await registerConnector(manifest(["subject", "body", "id"], "three"), { backfillRetrievalIndexes: false });
  releaseCompletion.release();
  await assert.rejects(oldCompletion, /manifest revision changed/);
  assert.deepEqual(await semanticMeta(), baselineMeta, "the old completion did not publish its obsolete identity");
  assert.equal((await dirtyRow())?.dirty, 1, "the stale completion did not clear the newer publication's dirty mark");

  const scope = { connectorId: CONNECTOR_ID, connectorInstanceId: INSTANCE_ID, stream: STREAM };
  const identityA = { dimensions: 8, distanceMetric: "cosine", fieldsFingerprint: "owner-a", modelId: "owner-a" };
  const identityB = { dimensions: 8, distanceMetric: "cosine", fieldsFingerprint: "owner-b", modelId: "owner-b" };
  const acquiredA = await inner.acquire({ identity: identityA, owner: "owner-a", scope });
  assert.equal(acquiredA.busy, false);
  if (acquiredA.busy) {
    throw new Error("unreachable");
  }
  await forceLeaseExpired();
  const acquiredB = await inner.acquire({ identity: identityB, owner: "owner-b", scope });
  assert.equal(acquiredB.busy, false);
  if (acquiredB.busy) {
    throw new Error("unreachable");
  }
  assert.ok(acquiredB.fence.generation > acquiredA.fence.generation);
  assert.equal(
    await inner.complete(scope, acquiredB.fence, {
      connectorId: CONNECTOR_ID,
      connectorInstanceId: INSTANCE_ID,
      dimensions: identityB.dimensions,
      distanceMetric: identityB.distanceMetric,
      fieldsFingerprint: identityB.fieldsFingerprint,
      manifest: manifest(["subject", "body", "id"], "three") as never,
      modelId: identityB.modelId,
      stream: STREAM,
    }),
    "complete"
  );
  const winnerMeta = await semanticMeta();
  assert.equal(winnerMeta?.fieldsFingerprint, identityB.fieldsFingerprint);
  assert.equal(
    await inner.complete(scope, acquiredA.fence, {
      connectorId: CONNECTOR_ID,
      connectorInstanceId: INSTANCE_ID,
      dimensions: identityA.dimensions,
      distanceMetric: identityA.distanceMetric,
      fieldsFingerprint: identityA.fieldsFingerprint,
      manifest: manifest(["subject", "body", "id"], "three") as never,
      modelId: identityA.modelId,
      stream: STREAM,
    }),
    "lost"
  );
  assert.deepEqual(await semanticMeta(), winnerMeta, "the expired owner could not overwrite owner B metadata");
  assert.equal((await dirtyRow())?.dirty, 0, "owner B's completion state survived owner A's stale completion");
});
