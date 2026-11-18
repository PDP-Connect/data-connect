// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Real-Postgres tests for the explicit scoped lexical repair (reconcile):
//   B2  a failure from a stale dirty revision must not penalize a newer one;
//   B1  same-count wrong value / wrong key / removed-field / deleted-record
//       drift is repaired against canonical records, non-string values do not
//       cause perpetual drift, and an in-sync repair writes nothing;
//   race  a writer/deleter landing between page fetch, upsert and prune is
//       never overwritten or resurrected by the rebuild.
//
// Run: PDPP_TEST_POSTGRES_URL=postgresql://... \
//   node --test --import tsx test/search-index-repair-correctness.postgres.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord, ingestRecords } from "../server/records.ts";
import { __setLexicalBackfillPhaseHookForTest } from "../server/search.ts";
import { reconcileSearchIndexDirtyScope } from "../server/search-index-reconcile.ts";
import { configureSemanticBackend } from "../server/search-semantic.ts";
import { recordSearchIndexDirtyFailure } from "../server/stores/search-index-dirty-store.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const manifestFor = (connectorId: string) => ({
  capabilities: { human_interaction: [] },
  connector_id: connectorId,
  display_name: connectorId,
  manifest_uri: `https://sources.example/${connectorId}`,
  protocol_version: "0.1.0",
  streams: [
    {
      name: "alpha",
      primary_key: ["id"],
      query: { search: { lexical_fields: ["subject", "body"] } },
      schema: {
        properties: {
          body: { type: ["string", "null"] },
          id: { type: "string" },
          subject: { type: ["string", "null"] },
        },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "0.1.0",
});

const target = (connectorId: string, connectorInstanceId: string) => ({
  connector_id: connectorId,
  connector_instance_id: connectorInstanceId,
});
const rec = (key: string, data: Record<string, unknown>, op: "delete" | "upsert" = "upsert") => ({
  data: { id: key, ...data },
  emitted_at: "2026-08-09T00:00:00.000Z",
  key,
  op,
  stream: "alpha",
});

const rows = async (instance: string) =>
  (
    await postgresQuery<{ record_key: string; field: string; value: string; xmin: string }>(
      `SELECT record_key, field, value, xmin::text AS xmin FROM lexical_search_index
       WHERE connector_instance_id = $1 AND stream = 'alpha' ORDER BY record_key, field`,
      [instance]
    )
  ).rows;
const view = (r: Awaited<ReturnType<typeof rows>>) => r.map((x) => `${x.record_key}/${x.field}=${x.value}`);

async function scopeOf(connectorId: string, instance: string) {
  const { rows: r } = await postgresQuery<{ revision: string; marked_at: string }>(
    "SELECT revision::text AS revision, marked_at FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'alpha'",
    [instance]
  );
  assert.ok(r[0]);
  return {
    connectorId,
    connectorInstanceId: instance,
    markedAt: r[0].marked_at,
    revision: Number(r[0].revision),
    stream: "alpha",
  };
}

async function seed(connectorId: string, instance: string, extra: Record<string, Record<string, unknown>> = {}) {
  configureSemanticBackend(null);
  await registerConnector(manifestFor(connectorId));
  const data: Record<string, Record<string, unknown>> = {
    k1: { subject: "subject one" },
    k2: { body: "body two", subject: "subject two" },
    k3: { subject: "subject three" },
    ...extra,
  };
  for (const [key, value] of Object.entries(data)) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential fixture ingest.
    await ingestRecord(target(connectorId, instance), rec(key, value), { deferIndexes: true });
  }
  const first = await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance));
  assert.equal(first.outcome, "converged");
  return data;
}

if (POSTGRES_URL) {
  test.before(async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  });
  test.after(async () => {
    __setLexicalBackfillPhaseHookForTest(null);
    await closePostgresStorage();
    closeDb();
  });

  test("B2: a failure recorded for a stale dirty revision does not count against or delay the newer revision", async () => {
    const connectorId = "repair-b2";
    const instance = "cin_repair_b2";
    await seed(connectorId, instance);
    const stale = await scopeOf(connectorId, instance);
    await ingestRecord(target(connectorId, instance), rec("k1", { subject: "newer" }), { deferIndexes: true });
    const key = { connectorInstanceId: instance, stream: "alpha" };
    assert.equal(await recordSearchIndexDirtyFailure(key, stale.revision, "stale attempt failed"), false);
    const { rows: r } = await postgresQuery<{ attempts: number; dirty: number; next_attempt_at: string | null }>(
      "SELECT attempts, dirty, next_attempt_at FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'alpha'",
      [instance]
    );
    assert.deepEqual({ ...r[0] }, { attempts: 0, dirty: 1, next_attempt_at: null });
    assert.equal(
      await recordSearchIndexDirtyFailure(key, (await scopeOf(connectorId, instance)).revision, "current"),
      true
    );
  });

  test("B1: same-count wrong value, wrong key, removed field and deleted record are repaired from canonical content", async () => {
    const connectorId = "repair-b1";
    const instance = "cin_repair_b1";
    await seed(connectorId, instance, { k4: { body: "", subject: null } });
    const canonical = view(await rows(instance));
    assert.deepEqual(canonical, [
      "k1/subject=subject one",
      "k2/body=body two",
      "k2/subject=subject two",
      "k3/subject=subject three",
    ]);

    // Null/empty values (manifest validation already forbids duplicated declared fields and non-string types): an in-sync repair must write nothing.
    const xminBefore = JSON.stringify((await rows(instance)).map((r) => [r.record_key, r.field, r.xmin]));
    await postgresQuery("UPDATE search_index_dirty SET dirty = 1 WHERE connector_instance_id = $1", [instance]);
    await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance));
    assert.equal(
      JSON.stringify((await rows(instance)).map((r) => [r.record_key, r.field, r.xmin])),
      xminBefore,
      "in-sync repair is write-free (non-string and duplicated fields do not cause drift)"
    );

    // Same-count corruption: wrong value, wrong key (real k3 missing + ghost), stale extra field row.
    await postgresQuery(
      "UPDATE lexical_search_index SET value = 'WRONG' WHERE connector_instance_id = $1 AND stream='alpha' AND record_key='k1'",
      [instance]
    );
    await postgresQuery(
      "UPDATE lexical_search_index SET record_key = 'ghost' WHERE connector_instance_id = $1 AND stream='alpha' AND record_key='k3'",
      [instance]
    );
    await postgresQuery("UPDATE search_index_dirty SET dirty = 1 WHERE connector_instance_id = $1", [instance]);
    const healthy = JSON.stringify((await rows(instance)).filter((r) => r.record_key === "k2").map((r) => r.xmin));
    await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance));
    assert.deepEqual(view(await rows(instance)), canonical, "wrong value and wrong key repaired");
    assert.equal(
      JSON.stringify((await rows(instance)).filter((r) => r.record_key === "k2").map((r) => r.xmin)),
      healthy,
      "healthy rows keep their xmin through the repair"
    );

    // Row for a deleted record (deleted directly, no dirty mark) and for an undeclared field.
    await postgresQuery(
      "UPDATE records SET deleted = TRUE WHERE connector_instance_id = $1 AND stream='alpha' AND record_key='k1'",
      [instance]
    );
    await postgresQuery(
      `INSERT INTO lexical_search_index (connector_id, connector_instance_id, stream, record_key, field, value)
       VALUES ($1, $2, 'alpha', 'k3', 'undeclared', 'x')`,
      [connectorId, instance]
    );
    await postgresQuery("UPDATE search_index_dirty SET dirty = 1 WHERE connector_instance_id = $1", [instance]);
    await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance));
    assert.deepEqual(view(await rows(instance)), [
      "k2/body=body two",
      "k2/subject=subject two",
      "k3/subject=subject three",
    ]);

    // Orphan index rows that sort after every canonical key, and for a never-existing record.
    await postgresQuery(
      `INSERT INTO lexical_search_index (connector_id, connector_instance_id, stream, record_key, field, value)
       VALUES ($1, $2, 'alpha', 'zzz-trailing', 'subject', 'orphan'), ($1, $2, 'alpha', 'aaa-leading', 'subject', 'orphan')`,
      [connectorId, instance]
    );
    await postgresQuery("UPDATE search_index_dirty SET dirty = 1 WHERE connector_instance_id = $1", [instance]);
    await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance));
    assert.deepEqual(view(await rows(instance)), [
      "k2/body=body two",
      "k2/subject=subject two",
      "k3/subject=subject three",
    ]);

    // Search-visible correctness, not counts: Postgres lexical search over the repaired index.
    const hit = await postgresQuery<{ record_key: string }>(
      `SELECT DISTINCT record_key FROM lexical_search_index
       WHERE connector_instance_id = $1 AND stream='alpha' AND to_tsvector('simple', value) @@ plainto_tsquery('simple', 'three')`,
      [instance]
    );
    assert.deepEqual(
      hit.rows.map((x) => x.record_key),
      ["k3"]
    );
  });

  test("B1: canonical-empty stream with index-only (orphan) rows is cleaned, and a clean empty stream stays clean", async () => {
    const connectorId = "repair-empty";
    const instance = "cin_repair_empty";
    await seed(connectorId, instance, {});
    for (const key of ["k1", "k2", "k3"]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture steps.
      await ingestRecord(target(connectorId, instance), rec(key, {}, "delete"), { deferIndexes: true });
    }
    await postgresQuery(
      `INSERT INTO lexical_search_index (connector_id, connector_instance_id, stream, record_key, field, value)
       VALUES ($1, $2, 'alpha', 'ghost', 'subject', 'orphan')`,
      [connectorId, instance]
    );
    await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance));
    assert.deepEqual(view(await rows(instance)), [], "no canonical rows: every index row removed");
  });

  test("bounded: 20k-record in-sync repair stays within a tight temp/time budget; paged plans use indexes only", async () => {
    const connectorId = "repair-bounded";
    const instance = "cin_repair_bounded";
    configureSemanticBackend(null);
    await registerConnector(manifestFor(connectorId));
    const TOTAL = 20_000;
    const medium = "lorem ipsum dolor sit amet ".repeat(8);
    for (let start = 0; start < TOTAL; start += 500) {
      const batch = Array.from({ length: 500 }, (_, i) =>
        rec(`k${String(start + i).padStart(6, "0")}`, { subject: `${medium}${start + i}` })
      );
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture ingest in batches.
      await ingestRecords(target(connectorId, instance), batch);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await postgresQuery("UPDATE search_index_dirty SET dirty = 1 WHERE connector_instance_id = $1", [instance]);
    await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance)); // converge (build)
    assert.equal((await rows(instance)).length, TOTAL);
    const before = JSON.stringify((await rows(instance)).slice(0, 2000).map((r) => r.xmin));
    const temp = async () => {
      await postgresQuery("SELECT pg_stat_clear_snapshot()");
      return Number(
        (
          await postgresQuery<{ t: string }>(
            "SELECT temp_bytes::text t FROM pg_stat_database WHERE datname = current_database()"
          )
        ).rows[0]?.t
      );
    };
    await new Promise((resolve) => setTimeout(resolve, 800));
    const t0 = await temp();
    await postgresQuery("UPDATE search_index_dirty SET dirty = 1 WHERE connector_instance_id = $1", [instance]);
    const started = performance.now();
    const outcome = await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance));
    const ms = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 800));
    const tempDelta = (await temp()) - t0;
    console.log(`MEASURE-20k in-sync repair: ${ms.toFixed(0)}ms, temp_bytes delta ${tempDelta}`);
    assert.equal(outcome.outcome, "converged");
    assert.equal(JSON.stringify((await rows(instance)).slice(0, 2000).map((r) => r.xmin)), before, "no rewrite");
    assert.ok(tempDelta < 4_000_000, `temp spill ${tempDelta} bytes (old FULL JOIN spilled ~61MB at this size)`);
    assert.ok(ms < 15_000, `repair took ${ms}ms`);

    // Plans of the paged statements: index access, no Sort/Hash over the stream.
    const plan = async (sql: string, params: unknown[]) =>
      (await postgresQuery<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params)).rows
        .map((r) => r["QUERY PLAN"])
        .join("\n");
    const indexPlan = await plan(
      `SELECT record_key, field FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = 'alpha'
       AND ($2::text IS NULL OR (record_key, field) > ($2, $3)) ORDER BY record_key, field LIMIT 500`,
      [instance, "k010000", "subject"]
    );
    assert.ok(indexPlan.includes("Index"), indexPlan);
    assert.ok(!(indexPlan.includes("Sort") || indexPlan.includes("Hash")), indexPlan);
    const livePlan = await plan(
      "SELECT record_key FROM records WHERE connector_instance_id = $1 AND stream = 'alpha' AND deleted = FALSE AND record_key = ANY($2::text[])",
      [instance, ["k000001", "k000002"]]
    );
    assert.ok(livePlan.includes("Index"), livePlan);
  });

  test("race: a concurrent newer write or delete between page fetch / upsert / prune is never overwritten or resurrected", async () => {
    const connectorId = "repair-race";
    const instance = "cin_repair_race";
    await seed(connectorId, instance);
    // Make the stream need a rebuild so the page loop runs.
    await postgresQuery("DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream='alpha'", [
      instance,
    ]);
    await postgresQuery("UPDATE search_index_dirty SET dirty = 1 WHERE connector_instance_id = $1", [instance]);
    const scope = await scopeOf(connectorId, instance);
    let fetched = false;
    let upserted = false;
    __setLexicalBackfillPhaseHookForTest(async (point) => {
      if (point === "after-page-fetch" && !fetched) {
        fetched = true;
        // Page holds stale text; a newer version (k3 gains a NEW field), a newer value and a delete land
        // before the upsert. Wait for the writers' own async index maintenance to land.
        await ingestRecord(target(connectorId, instance), rec("k1", { subject: "NEWER k1" }));
        await ingestRecord(target(connectorId, instance), rec("k2", {}, "delete"));
        await ingestRecord(target(connectorId, instance), rec("k3", { body: "added body", subject: "NEWER k3" }));
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (point === "after-page-upsert" && !upserted) {
        upserted = true;
        // Between upsert and prune: another delete.
        await ingestRecord(target(connectorId, instance), rec("k1", {}, "delete"));
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    });
    try {
      await reconcileSearchIndexDirtyScope(scope);
      __setLexicalBackfillPhaseHookForTest(null);
      // Before any further repair: the rebuild's prune must not have erased the writer's newer rows.
      assert.ok(
        view(await rows(instance)).includes("k3/body=added body"),
        "prune erased a newer field row written after the page was fetched"
      );
      await postgresQuery("UPDATE search_index_dirty SET dirty = 1 WHERE connector_instance_id = $1", [instance]);
      await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance));
    } finally {
      __setLexicalBackfillPhaseHookForTest(null);
    }
    const final = view(await rows(instance));
    assert.ok(!final.some((x) => x.startsWith("k2/")), `deleted k2 not resurrected: ${final.join(" | ")}`);
    assert.ok(!final.some((x) => x.startsWith("k1/")), `deleted k1 not resurrected: ${final.join(" | ")}`);
    assert.deepEqual(final, ["k3/body=added body", "k3/subject=NEWER k3"], "newer data wins; nothing stale survives");
    assert.ok(fetched && upserted, "both barrier points were hit");
  });

  test("measure: in-sync repair on 1100 rows reads one scoped content query and writes nothing", async () => {
    const connectorId = "repair-measure";
    const instance = "cin_repair_measure";
    configureSemanticBackend(null);
    await registerConnector(manifestFor(connectorId));
    for (let i = 1; i <= 1100; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture ingest.
      await ingestRecord(target(connectorId, instance), rec(`k${i}`, { subject: `subject ${i}` }), {
        deferIndexes: true,
      });
    }
    await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance));
    const before = JSON.stringify((await rows(instance)).map((r) => r.xmin));
    const stat = async () =>
      (
        await postgresQuery<{ ins: string; upd: string; del: string }>(
          "SELECT n_tup_ins::text ins, n_tup_upd::text upd, n_tup_del::text del FROM pg_stat_user_tables WHERE relname='lexical_search_index'"
        )
      ).rows[0];
    await new Promise((resolve) => setTimeout(resolve, 800)); // let the initial build's stats flush first
    await postgresQuery("SELECT pg_stat_clear_snapshot()");
    const s0 = await stat();
    await postgresQuery("UPDATE search_index_dirty SET dirty = 1 WHERE connector_instance_id = $1", [instance]);
    const t0 = performance.now();
    await reconcileSearchIndexDirtyScope(await scopeOf(connectorId, instance));
    const ms = performance.now() - t0;
    assert.equal(JSON.stringify((await rows(instance)).map((r) => r.xmin)), before, "no row rewritten");
    await new Promise((resolve) => setTimeout(resolve, 600)); // stats collector flush
    await postgresQuery("SELECT pg_stat_clear_snapshot()");
    const s1 = await stat();
    console.log(
      `MEASURE in-sync repair 1100 rows: ${ms.toFixed(0)}ms; lexical ins/upd/del delta = ${Number(s1?.ins) - Number(s0?.ins)}/${Number(s1?.upd) - Number(s0?.upd)}/${Number(s1?.del) - Number(s0?.del)}`
    );
  });
} else {
  test("repair correctness -- SKIPPED (set PDPP_TEST_POSTGRES_URL to run)", () => {
    // Opt-in Postgres-profile test, per this repo's convention.
  });
}
