// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore-all lint/performance/noAwaitInLoops: fixtures seed and drive passes strictly sequentially.
// biome-ignore-all lint/performance/useTopLevelRegex: one-shot assertion patterns inside single-use test bodies.
// biome-ignore-all lint/style/useDestructuring: row[0] access reads clearer than destructuring in these fixtures.
// biome-ignore-all lint/suspicious/useAwait: scenario callbacks share one async signature.

// Postgres-only proofs for the bounded semantic repair: the atomic write guard
// against the authoritative record version, lock-order/deadlock freedom against
// the live publisher, and plan-only EXPLAIN evidence that every read is
// index-backed. Behavioral scenarios shared with SQLite live in
// semantic-index-repair.test.ts.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { ingestRecord, maintainRecordIndexes } from "../server/records.ts";
import {
  configureSemanticBackend,
  createSemanticRepairStore,
  encodeScopeKey,
  makeStubBackend,
  semanticIndexBackfillForManifest,
} from "../server/search-semantic.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CONNECTOR_ID = "semantic-repair-pg";
const INSTANCE_ID = "cin_semantic_repair_pg";
const STREAM = "items";
const TARGET = { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID };
const SCOPE = { connectorId: CONNECTOR_ID, connectorInstanceId: INSTANCE_ID, stream: STREAM };
const SUBJECT_SCOPE = encodeScopeKey(STREAM, "subject");

const manifest = {
  capabilities: { human_interaction: [] },
  connector_id: CONNECTOR_ID,
  display_name: "Semantic repair PG fixture",
  manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
  protocol_version: "0.1.0",
  streams: [
    {
      name: STREAM,
      primary_key: ["id"],
      query: { search: { semantic_fields: ["subject"] } },
      schema: {
        properties: { id: { type: "string" }, subject: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

function envelope(key: string, text: string) {
  return { data: { id: key, subject: text }, emitted_at: "2026-10-14T00:00:00.000Z", key, stream: STREAM };
}

async function versionOf(key: string): Promise<number> {
  const rows = (
    await postgresQuery(
      "SELECT version FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
      [INSTANCE_ID, STREAM, key]
    )
  ).rows;
  return Number(rows[0]?.version);
}

async function storedVersions(): Promise<Map<string, number | null>> {
  const rows = (
    await postgresQuery(
      "SELECT record_key, source_version FROM semantic_search_blob WHERE connector_instance_id = $1",
      [INSTANCE_ID]
    )
  ).rows;
  return new Map(
    rows.map((row) => [row.record_key as string, row.source_version === null ? null : Number(row.source_version)])
  );
}

function withPostgres(name: string, run: () => Promise<void>) {
  test(`PostgreSQL: ${name}`, { skip: !POSTGRES_URL }, async () => {
    assert.ok(POSTGRES_URL);
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_test_semrepairpg_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}_1`,
        templateName: null,
      },
      async (databaseUrl) => {
        initDb(":memory:");
        try {
          await initPostgresStorage({ backend: "postgres", databaseUrl });
          configureSemanticBackend(makeStubBackend({ dimensions: 8 }));
          await registerConnector(manifest, { backfillRetrievalIndexes: false });
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

function entryFor(key: string, version: number) {
  return {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_ID,
    recordKey: key,
    scopeKey: SUBJECT_SCOPE,
    vector: new Float32Array(8).fill(0.25),
    version,
  };
}

async function openFence() {
  const store = createSemanticRepairStore({ leaseTtlMs: 60_000 });
  const acquired = await store.acquire({
    identity: { dimensions: 8, distanceMetric: "cosine", fieldsFingerprint: "x", modelId: "m" },
    owner: "test-owner",
    scope: SCOPE,
  });
  assert.equal(acquired.busy, false);
  if (acquired.busy) {
    throw new Error("unreachable");
  }
  return { fence: acquired.fence, store };
}

withPostgres(
  "the write guard is the AUTHORITATIVE record version: a version committed during the lock wait wins",
  async () => {
    await ingestRecord(TARGET, envelope("k1", "v1 text"), { deferIndexes: true });
    const v1 = await versionOf("k1");
    const { fence, store } = await openFence();

    // An ingest transaction bumps the record to v2 but has not committed yet.
    let commitIngest: () => void = () => undefined;
    const ingestMayCommit = new Promise<void>((resolve) => {
      commitIngest = resolve;
    });
    let ingestHasLock: () => void = () => undefined;
    const ingestLocked = new Promise<void>((resolve) => {
      ingestHasLock = resolve;
    });
    const ingestTx = withPostgresTransaction(async (client) => {
      await client.query(
        "UPDATE records SET version = version + 1 WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
        [INSTANCE_ID, STREAM, "k1"]
      );
      ingestHasLock();
      await ingestMayCommit;
    });
    await ingestLocked;

    // The repair embedded v1 text. Its write blocks on the records row lock...
    let settled = false;
    const write = Promise.resolve(store.writeEntries(SCOPE, fence, [entryFor("k1", v1)])).then((ok) => {
      settled = true;
      return ok;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, "the repair write waits for the in-flight version change");
    commitIngest();
    await ingestTx;
    // ... and, after the lock wait, sees v2 and writes nothing.
    assert.equal(await write, true);
    assert.deepEqual([...(await storedVersions())], [], "no older version landed");

    // A write at the CURRENT version lands and carries that version.
    await store.writeEntries(SCOPE, fence, [entryFor("k1", v1 + 1)]);
    assert.deepEqual([...(await storedVersions())], [["k1", v1 + 1]]);
  }
);

withPostgres("an old worker racing a new record version AND a new publisher: the newer version wins", async () => {
  await ingestRecord(TARGET, envelope("k1", "v1 text"), { deferIndexes: true });
  const v1 = await versionOf("k1");
  const { fence, store } = await openFence();
  // New version + its publisher commit while the old worker still holds a v1 embedding.
  await ingestRecord(TARGET, envelope("k1", "v2 text"), { deferIndexes: true });
  const v2 = await versionOf("k1");
  await maintainRecordIndexes(TARGET, envelope("k1", "v2 text"), v2, {});
  assert.deepEqual([...(await storedVersions())], [["k1", v2]]);
  await store.writeEntries(SCOPE, fence, [entryFor("k1", v1)]);
  assert.deepEqual([...(await storedVersions())], [["k1", v2]], "the old worker's write was dropped");
  // And the reverse interleaving: the publisher's write replaces a stale repair row.
  await store.writeEntries(SCOPE, fence, [entryFor("k1", v2)]);
  assert.deepEqual([...(await storedVersions())], [["k1", v2]]);
});

withPostgres(
  "lock order: repair writes, orphan deletes, profile reset, ingest and the live publisher never deadlock",
  async () => {
    const keys = Array.from({ length: 12 }, (_, index) => `k${index}`);
    for (const key of keys) {
      await ingestRecord(TARGET, envelope(key, `seed ${key}`), { deferIndexes: true });
    }
    const { fence, store } = await openFence();
    const errors: unknown[] = [];
    const guard = async (work: () => unknown) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    const rounds = 25;
    // Ingest + live publish run as ONE sequential writer (the production shape:
    // a per-instance lane); everything else races it concurrently.
    const tasks: Promise<void>[] = [
      guard(async () => {
        for (let round = 0; round < rounds; round += 1) {
          const key = keys[round % keys.length] as string;
          await ingestRecord(TARGET, envelope(key, `edit ${round}`), { deferIndexes: true });
          await maintainRecordIndexes(TARGET, envelope(key, `edit ${round}`), await versionOf(key), {});
        }
      }),
    ];
    for (let round = 0; round < rounds; round += 1) {
      const key = keys[round % keys.length] as string;
      const other = keys[(round * 5 + 3) % keys.length] as string;
      tasks.push(
        guard(async () => {
          const versions = await Promise.all(keys.map((candidate) => versionOf(candidate)));
          await store.writeEntries(
            SCOPE,
            fence,
            keys.map((candidate, index) => entryFor(candidate, versions[index] as number))
          );
        }),
        guard(() => store.deleteOrphans(SCOPE, fence, SUBJECT_SCOPE, [other, key])),
        guard(() => store.deleteEmptied(SCOPE, fence, [{ recordKey: other, scopeKey: SUBJECT_SCOPE, version: 1 }])),
        guard(() => store.saveCursor(SCOPE, fence, { id: round, p: "records" })),
        guard(() =>
          store.resetPass(SCOPE, fence, {
            identity: { dimensions: 8, distanceMetric: "cosine", fieldsFingerprint: "x", modelId: "m" },
            kind: "repair",
          })
        ),
        guard(() => store.deleteStreamRows(SCOPE, fence))
      );
    }
    await Promise.all(tasks);
    const deadlocks = errors.filter((error) => (error as { code?: string }).code === "40P01");
    assert.deepEqual(deadlocks, [], "no deadlock_detected (40P01) across the interleavings");
    assert.deepEqual(errors, [], "no lock timeout or other error either");
    // Convergence: one clean pass leaves every live row current.
    const embedder = makeStubBackend({ dimensions: 8 });
    configureSemanticBackend(embedder);
    await store.release(SCOPE, fence);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await semanticIndexBackfillForManifest({
        manifest: { ...manifest, storage_binding: { connector_instance_id: INSTANCE_ID } } as never,
      });
      if (result.scopes.every((scope) => scope.status === "complete")) {
        break;
      }
    }
    const stored = await storedVersions();
    for (const key of keys) {
      assert.equal(stored.get(key), await versionOf(key), `${key} is current after convergence`);
    }
  }
);

withPostgres("EXPLAIN (plan only): every repair read is index-backed", async () => {
  // Seed enough rows that the planner has a real choice: 600 records, 300,000 semantic rows in the scope under test and 20,000 foreign-instance rows.
  for (let index = 0; index < 600; index += 1) {
    await ingestRecord(TARGET, envelope(`r${String(index).padStart(6, "0")}`, `text ${index}`), { deferIndexes: true });
  }
  // Bulk-clone one real record row so the planner sees a realistically sized
  // records table: 250,000 rows for another instance in the low id range, then
  // 10,000 for the instance under test (the production skew that motivated
  // idx_pg_records_instance_stream_id).
  const cloneRecords = async (instance: string, prefix: string, idOffset: number, count: number) =>
    await postgresQuery(
      `INSERT INTO records
       SELECT (jsonb_populate_record(NULL::records,
                 to_jsonb(b) || jsonb_build_object('id', $3::bigint + g, 'connector_instance_id', $1::text,
                                                  'record_key', $2::text || g::text, 'version', g))).*
         FROM (SELECT * FROM records WHERE record_key = 'r000000' LIMIT 1) b, generate_series(1, $4::int) AS g`,
      [instance, prefix, idOffset, count]
    );
  await cloneRecords("cin_other_records", "f", 1_000_000, 250_000);
  await cloneRecords(INSTANCE_ID, "z", 2_000_000, 10_000);
  await postgresQuery(
    `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding, source_version)
     SELECT $1, $2, $3, 'r' || lpad(g::text, 6, '0'), '[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8]'::vector, 1
       FROM generate_series(0, 299999) AS g`,
    [CONNECTOR_ID, INSTANCE_ID, SUBJECT_SCOPE]
  );
  await postgresQuery(
    `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding, source_version)
     SELECT $1, 'cin_other_' || (g % 40), $2, 'o' || g::text, '[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8]'::vector, 1
       FROM generate_series(0, 19999) AS g`,
    [CONNECTOR_ID, SUBJECT_SCOPE]
  );
  await postgresQuery("ANALYZE semantic_search_blob", []);
  await postgresQuery("ANALYZE records", []);
  await postgresQuery("ANALYZE semantic_search_backfill_progress", []);
  await postgresQuery("ANALYZE semantic_search_meta", []);
  const keysParam = Array.from({ length: 500 }, (_, index) => `r${String(index).padStart(6, "0")}`);

  async function plan(label: string, sql: string, params: unknown[]): Promise<string> {
    const result = await postgresQuery(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    const text = JSON.stringify(result.rows[0]?.["QUERY PLAN"]);
    const nodes: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      nodes.push(
        `${node["Node Type"]}${node["Index Name"] ? `[${node["Index Name"]}]` : ""}${node["Index Cond"] ? ` cond=${String(node["Index Cond"]).slice(0, 70)}…` : ""}${node.Filter ? ` filter=${String(node.Filter).slice(0, 40)}…` : ""}`
      );
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) {
        walk(child);
      }
    };
    walk((JSON.parse(text)[0] as { Plan: Record<string, unknown> }).Plan);
    console.log(`PLAN ${label}: ${nodes.join(" > ")}`);
    return text;
  }

  const probe = await plan(
    "version probe (PK)",
    `SELECT scope_key, record_key, source_version FROM semantic_search_blob
      WHERE connector_instance_id = $1 AND scope_key = ANY($2::text[]) AND record_key = ANY($3::text[])`,
    [INSTANCE_ID, [SUBJECT_SCOPE], keysParam]
  );
  assert.match(probe, /semantic_search_blob_pkey/);
  assert.doesNotMatch(probe, /Seq Scan/);

  const orphans = await plan(
    "orphan keyset page (PK order)",
    `SELECT record_key FROM semantic_search_blob
      WHERE connector_instance_id = $1 AND scope_key = $2 AND ($3::text IS NULL OR record_key > $3)
      ORDER BY record_key ASC LIMIT 500`,
    [INSTANCE_ID, SUBJECT_SCOPE, "r000100"]
  );
  assert.match(orphans, /semantic_search_blob_pkey/);
  assert.doesNotMatch(orphans, /"Node Type":"Sort"/);
  assert.doesNotMatch(orphans, /Seq Scan/);

  const page = await plan(
    "records keyset page",
    `SELECT id, record_key, version FROM records
      WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE AND id > $3 ORDER BY id ASC LIMIT 500`,
    [INSTANCE_ID, STREAM, 0]
  );
  assert.match(page, /idx_pg_records_instance_stream_id/);
  assert.doesNotMatch(page, /"Node Type":"Sort"/);
  assert.doesNotMatch(page, /Seq Scan/);

  const live = await plan(
    "live-key probe",
    "SELECT record_key FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = ANY($3::text[]) AND deleted = FALSE",
    [INSTANCE_ID, STREAM, keysParam]
  );
  assert.match(live, /idx_pg_records_lookup|records_connector_instance_id_stream_record_key_key/);
  assert.doesNotMatch(live, /Seq Scan/);

  // computeIndexState probes: both tables hold at most one row per
  // (connector_instance, stream) scope, so a no-match probe reads that tiny
  // table, never a scope's rows. Recorded here rather than asserted as an index scan.
  await plan("computeIndexState: progress exists", "SELECT 1 AS n FROM semantic_search_backfill_progress LIMIT 1", []);
  await plan(
    "computeIndexState: meta identities",
    "SELECT model_id, dimensions, distance_metric FROM semantic_search_meta",
    []
  );
});
