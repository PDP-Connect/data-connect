// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Real storage regression for the durable-ingest/deferred-publication crash
// window. Canonical and actual key/input identities, not row counts, establish
// convergence. The matrix below exercises both SQLite implementations and PG.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { registerConnector } from "../server/auth.ts";
import { connectorInstanceAdvisoryLockKey } from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { postgresSemanticIndexCandidatesPage } from "../server/postgres-search.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresBulkTransaction,
} from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { ingestRecord, maintainRecordIndexes } from "../server/records.ts";
import { reconcileSearchIndexDirtyScope } from "../server/search-index-reconcile.ts";
import {
  __setSemanticRepairPhaseHookForTest,
  __setSemanticVecInventoryFaultHookForTest,
  applySemanticEntriesWithClient,
  computeSemanticEntries,
  configureSemanticBackend,
  DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS,
  getSemanticIndexBackfillProgress,
  isSemanticIndexBackfillActive,
  makeStubBackend,
  resetVectorIndexForTests,
  semanticIndexBackfillForManifest,
  semanticIndexUpsert,
} from "../server/search-semantic.ts";
import { listDirtySearchIndexScopes } from "../server/stores/search-index-dirty-store.ts";

function target(connectorInstanceId: string) {
  return {
    connector_id: "crash-gap",
    connector_instance_id: connectorInstanceId,
  };
}

function record(stream: string, key: string, subject: string) {
  return {
    data: { id: key, subject },
    emitted_at: "2026-07-16T00:00:00.000Z",
    key,
    stream,
  };
}

const baseManifest = {
  capabilities: { human_interaction: [] },
  connector_id: "crash-gap",
  display_name: "Crash gap probe",
  manifest_uri: "https://registry.pdpp.dev/connectors/crash-gap",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      query: { search: {} },
      schema: {
        properties: { id: { type: "string" }, subject: { type: "string" } },
        required: ["id", "subject"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

const semanticManifest = {
  ...baseManifest,
  streams: baseManifest.streams.map((stream) => ({
    ...stream,
    query: { search: { semantic_fields: ["subject"] } },
  })),
};

/**
 * A real publisher in a separate Node process, therefore a separate
 * PostgreSQL client/pool. This deliberately uses the public ingest and
 * manifest paths rather than reproducing either writer's SQL in the test.
 */
async function reintroduceStreamFromFreshPostgresProcess({
  manifest,
  connectorInstanceId,
  childAttachment,
}: {
  manifest: Record<string, unknown>;
  connectorInstanceId: string;
  childAttachment: string;
}): Promise<number> {
  const program = `
    import { registerConnector } from "./server/auth.ts";
    import { closePostgresStorage, initPostgresStorage, postgresQuery } from "./server/postgres-storage.ts";
    import { ingestRecord } from "./server/records.ts";
    const manifest = JSON.parse(process.env.PDPP_R6_MANIFEST);
    const connectorInstanceId = process.env.PDPP_R6_INSTANCE;
    await initPostgresStorage(
      { backend: "postgres", databaseUrl: process.env.PDPP_TEST_POSTGRES_URL },
      { testOnlyAlreadyAdmittedChildAttachment: process.env.PDPP_R6_CHILD_ATTACHMENT }
    );
    try {
      await registerConnector(manifest, { backfillRetrievalIndexes: false });
      await ingestRecord(
        { connector_id: manifest.connector_id, connector_instance_id: connectorInstanceId },
        { stream: "items", key: "k1", data: { id: "k1", subject: "current" }, emitted_at: "2026-07-16T00:00:00.000Z" },
        { deferIndexes: true }
      );
      const result = await postgresQuery("SELECT pg_backend_pid() AS pid");
      console.log(JSON.stringify({ pid: Number(result.rows[0].pid) }));
    } finally {
      await closePostgresStorage();
    }
  `;
  const loaderArgs = process.env.PDPP_TEST_COMPAT_LOADER
    ? ["--experimental-loader", process.env.PDPP_TEST_COMPAT_LOADER]
    : [];
  const child = spawn(process.execPath, [...loaderArgs, "--import", "tsx", "--input-type=module", "--eval", program], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PDPP_R6_INSTANCE: connectorInstanceId,
      PDPP_R6_MANIFEST: JSON.stringify(manifest),
      PDPP_R6_CHILD_ATTACHMENT: childAttachment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, `fresh canonical publisher failed: ${stderr}`);
  const line = stdout.trim().split("\n").at(-1);
  const pid = line ? (JSON.parse(line) as { pid: number }).pid : NaN;
  assert.ok(Number.isInteger(pid), `fresh canonical publisher did not report its PostgreSQL pid: ${stdout}`);
  return pid;
}

test("startup semantic backfill catches a record whose index maintenance never ran (crash-abandoned deferred index work)", async () => {
  initDb(":memory:");
  configureSemanticBackend(makeStubBackend({ dimensions: 8 }));
  try {
    await registerConnector(baseManifest);
    // Record 1: normal ingest, index maintenance runs (deferIndexes defaults false).
    await ingestRecord(target("cin_crash_gap_a"), record("items", "k1", "indexed normally"));
    await registerConnector(semanticManifest, { backfillRetrievalIndexes: false });

    // Establish steady-state meta (fields_fingerprint/model/dims persisted)
    // via a first backfill pass BEFORE the crash-abandoned record exists —
    // this is the realistic "server has run before, meta already exists"
    // condition. Only after this does the discriminator (does a SUBSEQUENT
    // backfill catch a newly under-indexed record?) actually test anything;
    // on a cold DB with no meta row, `!metaRow` alone forces a full rebuild
    // regardless of the count-sync logic, which doesn't discriminate.
    await semanticIndexBackfillForManifest({ manifest: semanticManifest });

    // Record 2: simulate crash-abandoned deferred index work — durable write
    // happened (deferIndexes: true skips maintainRecordIndexes entirely, same
    // end state as a process dying before the fire-and-forget promise runs).
    await ingestRecord(target("cin_crash_gap_a"), record("items", "k2", "never indexed"), {
      deferIndexes: true,
    });

    // Second backfill pass = "server restarted again" with meta already in place.
    await semanticIndexBackfillForManifest({ manifest: semanticManifest });

    // If backfill is a real repair mechanism, a second explicit backfill call
    // (simulating "server restarted again") should find nothing left to do,
    // AND the record should actually be present in the index. Assert directly.

    // Use the DB directly to check whether k2's semantic index row exists.
    // Check the selected SQLite backend's durable index identity rows.
    const { getDb } = await import("../server/db.ts");
    const rowidRows = getDb()
      .prepare("SELECT DISTINCT record_key FROM semantic_search_rowid WHERE connector_instance_id = ?")
      .all("cin_crash_gap_a") as { record_key: string }[];
    const blobRows = getDb()
      .prepare("SELECT DISTINCT record_key FROM semantic_search_blob WHERE connector_instance_id = ?")
      .all("cin_crash_gap_a") as { record_key: string }[];
    const keys = [...new Set([...rowidRows, ...blobRows].map((r) => r.record_key))].sort();
    assert.deepEqual(keys, ["k1", "k2"], "startup backfill should have caught the crash-abandoned record k2");
  } finally {
    closeDb();
  }
});

test("startup semantic backfill repairs same-key A→B content when counts already match", async () => {
  initDb(":memory:");
  configureSemanticBackend(makeStubBackend({ dimensions: 8 }));
  try {
    await registerConnector(baseManifest);
    await ingestRecord(target("cin_crash_gap_identity"), record("items", "k1", "semantic input A"));
    await registerConnector(semanticManifest, {
      backfillRetrievalIndexes: false,
    });
    await semanticIndexBackfillForManifest({ manifest: semanticManifest });

    const { getDb } = await import("../server/db.ts");
    const read = () =>
      getDb()
        .prepare(
          `SELECT input_identity, embedding FROM semantic_search_blob WHERE connector_instance_id = ? AND record_key = ?
           UNION ALL
           SELECT input_identity, NULL AS embedding FROM semantic_search_rowid WHERE connector_instance_id = ? AND record_key = ?`
        )
        .get("cin_crash_gap_identity", "k1", "cin_crash_gap_identity", "k1") as {
        input_identity: string | null;
        embedding: Buffer | null;
      };
    const before = read();
    assert.ok(before.input_identity, "initial publication records its source identity");

    // Durable B plus deferred-index crash leaves the old A vector in place.
    // Cardinality is still one, so the former count/key verifier treated it
    // as converged and did not rebuild it.
    await ingestRecord(target("cin_crash_gap_identity"), record("items", "k1", "semantic input B"), {
      deferIndexes: true,
    });
    await semanticIndexBackfillForManifest({ manifest: semanticManifest });

    const after = read();
    assert.ok(after.input_identity);
    assert.notEqual(after.input_identity, before.input_identity, "the current normalized input replaces A's identity");
    if (before.embedding && after.embedding) {
      assert.notDeepEqual(
        after.embedding,
        before.embedding,
        "the stored vector is republished with B, not merely certified by count"
      );
    }
  } finally {
    closeDb();
  }
});

test("semantic backfill removes an entry when its declared field becomes empty", async () => {
  initDb(":memory:");
  configureSemanticBackend(makeStubBackend({ dimensions: 8 }));
  try {
    await registerConnector(baseManifest);
    await ingestRecord(target("cin_semantic_empty"), record("items", "k1", "present"));
    await registerConnector(semanticManifest, {
      backfillRetrievalIndexes: false,
    });
    await semanticIndexBackfillForManifest({ manifest: semanticManifest });
    await ingestRecord(target("cin_semantic_empty"), record("items", "k1", ""), { deferIndexes: true });
    await semanticIndexBackfillForManifest({ manifest: semanticManifest });
    const { getDb } = await import("../server/db.ts");
    const indexed = getDb()
      .prepare(
        `SELECT record_key FROM semantic_search_blob WHERE connector_instance_id = ?
         UNION ALL SELECT record_key FROM semantic_search_rowid WHERE connector_instance_id = ?`
      )
      .all("cin_semantic_empty", "cin_semantic_empty");
    assert.deepEqual(indexed, [], "an empty current semantic input has no retained vector/sidecar row");
  } finally {
    closeDb();
  }
});

test("a 501-field manifest publishes bounded batches and restart embeds only the missing identity", async () => {
  initDb(":memory:");
  const fields = Array.from({ length: 501 }, (_, index) => `field_${index}`);
  const properties = Object.fromEntries(fields.map((field) => [field, { type: "string" }]));
  const manifest = {
    ...semanticManifest,
    connector_id: "semantic-field-batches",
    streams: [
      {
        ...semanticManifest.streams[0],
        query: { search: { semantic_fields: fields } },
        schema: { properties: { id: { type: "string" }, ...properties }, type: "object" },
      },
    ],
  };
  let calls = 0;
  const stub = makeStubBackend({ dimensions: 8 });
  configureSemanticBackend({
    ...stub,
    embedDocument: async (text) => {
      calls += 1;
      return stub.embedDocument(text);
    },
  });
  try {
    await registerConnector(manifest, { backfillRetrievalIndexes: false });
    const values = Object.fromEntries(fields.map((field) => [field, field]));
    await ingestRecord(
      { connector_id: manifest.connector_id, connector_instance_id: "cin_semantic_field_batches" },
      { data: { id: "k1", ...values }, emitted_at: "2026-07-16T00:00:00.000Z", key: "k1", stream: "items" },
      { deferIndexes: true }
    );
    let failed = false;
    __setSemanticRepairPhaseHookForTest((phase) => {
      if (phase !== "after-field-batch-publish" || failed) return;
      failed = true;
      throw new Error("field batch interruption");
    });
    const backfillManifest = manifest as NonNullable<
      NonNullable<Parameters<typeof semanticIndexBackfillForManifest>[0]>["manifest"]
    >;
    await assert.rejects(semanticIndexBackfillForManifest({ manifest: backfillManifest }), /field batch interruption/);
    assert.equal(calls, 500, "the first publication batch contains at most 500 field pairs");
    __setSemanticRepairPhaseHookForTest(null);
    await semanticIndexBackfillForManifest({ manifest: backfillManifest });
    assert.equal(calls, 501, "restart must reuse the first 500 identities and embed only the missing field");
    const table = getDb().vectorIndexKind === "sqlite-vec" ? "semantic_search_rowid" : "semantic_search_blob";
    assert.equal(
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_instance_id = ?`)
        .get<{ n: number }>("cin_semantic_field_batches")?.n,
      501
    );
  } finally {
    __setSemanticRepairPhaseHookForTest(null);
    configureSemanticBackend(null);
    closeDb();
  }
});

interface ContractSqlRow {
  rowid: number;
  input_identity: string | null;
  record_key: string;
  scope_key: string;
  revision: string | number;
  version: string | number;
  dirty: number;
  n: string | number;
  embedding: unknown;
}

function required<T>(value: T | undefined): T {
  assert.ok(value, "the real backend must return the fixture row");
  return value;
}

// Real-backend contract suite. Model calls are deterministic; persistence,
// transactions, crashes, identity corruption and barriers use the actual repo.
for (const kind of ["blob-flat", "sqlite-vec", "postgres"] as const) {
  test(`semantic identity convergence (${kind})`, {
    skip: kind === "postgres" && !process.env.PDPP_TEST_POSTGRES_URL ? "PDPP_TEST_POSTGRES_URL unset" : false,
  }, async (t) => {
    let sequence = 0;
    const runId = randomUUID().slice(0, 8);
    async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
      const f = await setup();
      try {
        await run(f);
      } finally {
        __setSemanticRepairPhaseHookForTest(null);
        configureSemanticBackend(null);
        resetVectorIndexForTests();
        if (kind === "postgres") {
          // A deliberately failing mutation must not leak its injected fault
          // trigger into the next independent fixture in the same database.
          await postgresQuery("DROP TRIGGER IF EXISTS fail_identity ON semantic_search_blob");
          await postgresQuery("DELETE FROM records WHERE connector_id = $1", [f.connector]);
          await closePostgresStorage();
        }
        closeDb();
      }
    }
    async function setup() {
      initDb(":memory:");
      resetVectorIndexForTests(kind === "blob-flat" ? "blob-flat" : undefined);
      if (kind === "sqlite-vec") assert.equal(getDb().vectorIndexKind, "sqlite-vec", "vec0 must actually be loaded");
      if (kind === "postgres")
        await initPostgresStorage({
          backend: "postgres",
          databaseUrl: process.env.PDPP_TEST_POSTGRES_URL as string,
        });
      const instance = `cin_identity_${kind.replaceAll("-", "_")}_${runId}_${++sequence}`;
      const connector = `identity-${kind}-${runId}-${sequence}`;
      const manifest = {
        ...semanticManifest,
        connector_id: connector,
        display_name: connector,
        streams: ["items", "item_", "item%", "itemX"].map((name) => ({
          ...required(semanticManifest.streams[0]),
          name,
        })),
      };
      const inputs: string[] = [];
      const stub = makeStubBackend({ dimensions: 8 });
      const embedding = {
        ...stub,
        embedDocument: async (text: string) => {
          inputs.push(text);
          return stub.embedDocument(text);
        },
      };
      configureSemanticBackend(embedding);
      await registerConnector(manifest, { backfillRetrievalIndexes: false });
      const childAttachment =
        kind === "postgres"
          ? await createAlreadyAdmittedTestDatabaseChildAttachment(process.env.PDPP_TEST_POSTGRES_URL as string)
          : undefined;
      const table = kind === "sqlite-vec" ? "semantic_search_rowid" : "semantic_search_blob";
      async function sql(query: string, args: unknown[] = []): Promise<ContractSqlRow[]> {
        if (kind === "postgres") return (await postgresQuery<ContractSqlRow>(query, args)).rows;
        const params: unknown[] = [];
        const sqlite = query.replace(/\$(\d+)/g, (_match, n) => {
          params.push(args[Number(n) - 1]);
          return "?";
        });
        const stmt = getDb().prepare(sqlite);
        if ((stmt as typeof stmt & { reader: boolean }).reader) return stmt.all(...params) as ContractSqlRow[];
        stmt.run(...params);
        return [];
      }
      async function ingest(key: string, subject: string, stream = "items", extra: Record<string, unknown> = {}) {
        const outcome = await ingestRecord(
          { connector_id: connector, connector_instance_id: instance },
          {
            ...record(stream, key, subject),
            data: { id: key, subject, ...extra },
          },
          { deferIndexes: true }
        );
        assert.equal(outcome.accepted, true);
      }
      const pinned = (stream = "items") => ({
        ...manifest,
        connector_instance_id: instance,
        streams: manifest.streams.filter((s) => s.name === stream),
      });
      async function repair(stream = "items") {
        await semanticIndexBackfillForManifest({
          manifest: pinned(stream),
          orphanStreamCleanup: false,
        });
      }
      async function rows(stream = "items") {
        return sql(
          `SELECT scope_key, record_key, input_identity FROM ${table} WHERE connector_instance_id = $1 AND scope_key = $2 ORDER BY record_key`,
          [instance, JSON.stringify([stream, "subject"])]
        );
      }
      async function vector(key = "k1") {
        if (kind === "sqlite-vec")
          return getDb()
            .prepare(
              `SELECT v.embedding FROM semantic_search_vec v JOIN semantic_search_rowid s ON s.rowid = v.rowid WHERE s.connector_instance_id = ? AND s.scope_key = ? AND s.record_key = ?`
            )
            .get(instance, '["items","subject"]', key);
        return (
          await sql(
            `SELECT embedding FROM ${table} WHERE connector_instance_id = $1 AND scope_key = $2 AND record_key = $3`,
            [instance, '["items","subject"]', key]
          )
        )[0];
      }
      // DML oracle is storage, not a mocked call counter. Include meta and
      // progress so an always-rebuild verifier also fails the healthy check.
      if (kind !== "postgres") {
        getDb().exec(`CREATE TABLE semantic_test_writes(n INTEGER);`);
        for (const name of [table, "semantic_search_meta", "semantic_search_backfill_progress"]) {
          for (const op of ["INSERT", "UPDATE", "DELETE"])
            getDb().exec(
              `CREATE TRIGGER audit_${name}_${op} AFTER ${op} ON ${name} BEGIN INSERT INTO semantic_test_writes VALUES(1); END;`
            );
        }
      } else {
        await sql("CREATE TABLE IF NOT EXISTS semantic_test_writes(n INTEGER)");
        await sql(
          "CREATE OR REPLACE FUNCTION semantic_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO semantic_test_writes VALUES(1); RETURN NULL; END $$"
        );
        for (const name of [table, "semantic_search_meta", "semantic_search_backfill_progress"]) {
          await sql(`DROP TRIGGER IF EXISTS identity_audit ON ${name}`);
          await sql(
            `CREATE TRIGGER identity_audit AFTER INSERT OR UPDATE OR DELETE ON ${name} FOR EACH ROW EXECUTE FUNCTION semantic_test_audit()`
          );
        }
      }
      const writes = async () => Number(required((await sql("SELECT COUNT(*) AS n FROM semantic_test_writes"))[0]).n);
      return {
        instance,
        connector,
        manifest,
        embedding,
        inputs,
        table,
        sql,
        ingest,
        repair,
        rows,
        vector,
        writes,
        pinned,
        childAttachment,
      };
    }

    await t.test(
      "same-key A→B crash repairs actual vector then clears current dirty revision; healthy/noop sweeps do zero model calls and DML",
      async () =>
        fixture(async (f) => {
          await f.ingest("k1", "A");
          await f.repair();
          const before = await f.vector();
          await f.ingest("k1", "B");
          const scope = required(
            (await listDirtySearchIndexScopes(100)).find((s) => s.connectorInstanceId === f.instance)
          );
          const result = await reconcileSearchIndexDirtyScope(scope);
          assert.equal(result.outcome, "converged");
          assert.notDeepEqual(await f.vector(), before, "B's vector, not merely its identity, must replace A");
          assert.equal(f.inputs.at(-1), "B");
          const calls = f.inputs.length,
            dml = await f.writes();
          // Vec0 cannot host audit triggers. Its repair captures one
          // metadata-only TEMP inventory row per physical vector; audit
          // triggers below still prove no durable semantic DML on a healthy
          // pass.
          const sqliteChanges =
            kind === "postgres" ? null : getDb().prepare("SELECT total_changes() AS n").get<{ n: number }>()?.n;
          await f.repair();
          assert.equal(f.inputs.length, calls);
          assert.equal(await f.writes(), dml, "healthy verifier must be entirely read-only");
          if (kind !== "postgres")
            assert.equal(
              getDb().prepare("SELECT total_changes() AS n").get<{ n: number }>()?.n,
              (sqliteChanges ?? 0) + (kind === "sqlite-vec" ? 1 : 0)
            );
          await f.ingest("k1", "B");
          await f.repair();
          assert.equal(f.inputs.length, calls);
          assert.equal(await f.writes(), dml);
        })
    );

    await t.test(
      "malformed or noncanonical derived scope keys remain dirty while canonical sibling encodings are preserved",
      async () =>
        fixture(async (f) => {
          await f.ingest("k1", "current");
          await f.repair();
          const vectorLiteral = kind === "postgres" ? "'[0,0,0,0,0,0,0,0]'::vector" : "X'0000000000000000'";
          let rowid = 90_000;
          const insertDerivedScope = async (scopeKey: string, recordKey: string) => {
            if (kind === "sqlite-vec") {
              await f.sql(
                `INSERT INTO ${f.table}(rowid,connector_instance_id,connector_id,scope_key,record_key,input_identity)
                 VALUES($1,$2,$3,$4,$5,$6)`,
                [rowid++, f.instance, f.connector, scopeKey, recordKey, "untrusted"]
              );
              return;
            }
            await f.sql(
              `INSERT INTO ${f.table}(connector_instance_id,connector_id,scope_key,record_key,embedding,input_identity)
               VALUES($1,$2,$3,$4,${vectorLiteral},$5)`,
              [f.instance, f.connector, scopeKey, recordKey, "untrusted"]
            );
          };

          // Exact JSON.stringify encodings include a Unicode scalar, a quote,
          // and empty strings. They belong to sibling streams and must neither
          // poison the inventory nor be selected for the items repair.
          const canonicalSibling = JSON.stringify(["itemX", 'quote"é']);
          const canonicalEmpty = JSON.stringify(["", ""]);
          await insertDerivedScope(canonicalSibling, "sibling-unicode");
          await insertDerivedScope(canonicalEmpty, "sibling-empty");
          await f.repair();
          assert.equal(
            (
              await f.sql(`SELECT scope_key FROM ${f.table} WHERE connector_instance_id = $1 AND record_key = $2`, [
                f.instance,
                "sibling-unicode",
              ])
            ).length,
            1,
            "a canonical quoted Unicode sibling is outside the items repair scope"
          );

          await insertDerivedScope("not json", "malformed");
          await assert.rejects(f.repair(), /semantic index did not converge/);
          await insertDerivedScope('["items","subject" ]', "noncanonical-two-strings");
          assert.equal(
            (
              await f.sql(`SELECT scope_key FROM ${f.table} WHERE connector_instance_id = $1 AND record_key = $2`, [
                f.instance,
                "malformed",
              ])
            ).length,
            1,
            "fail-closed inventory does not erase untrusted derived evidence"
          );
          assert.equal(
            (
              await f.sql(`SELECT scope_key FROM ${f.table} WHERE connector_instance_id = $1 AND record_key = $2`, [
                f.instance,
                "sibling-unicode",
              ])
            ).length,
            1,
            "a failed items repair does not delete a canonical sibling"
          );
        })
    );

    if (kind === "blob-flat" || kind === "postgres")
      await t.test(
        "an empty canonical stream verifies untrusted derived scope keys before a dirty reconcile can clear",
        async () =>
          fixture(async (f) => {
            await f.ingest("k1", "prior");
            const scope = required(
              (await listDirtySearchIndexScopes(1000)).find((candidate) => candidate.connectorInstanceId === f.instance)
            );
            await f.sql("DELETE FROM records WHERE connector_instance_id = $1 AND stream = $2", [f.instance, "items"]);
            const vectorLiteral = kind === "postgres" ? "'[0,0,0,0,0,0,0,0]'::vector" : "X'0000000000000000'";
            await f.sql(
              `INSERT INTO ${f.table}(connector_instance_id,connector_id,scope_key,record_key,embedding,input_identity)
               VALUES($1,$2,$3,$4,${vectorLiteral},$5)`,
              [f.instance, f.connector, '[ "items","body"]', "orphan", "untrusted"]
            );
            const result = await reconcileSearchIndexDirtyScope(scope);
            assert.equal(result.outcome, "failed", "untrusted inventory must keep the dirty scope nonconverged");
            assert.equal(
              Number(
                required(
                  (
                    await f.sql(
                      "SELECT dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
                      [f.instance, "items"]
                    )
                  )[0]
                ).dirty
              ),
              1,
              "reconcile must not clear dirty state without a canonical-scope proof"
            );
            assert.equal(
              (
                await f.sql(`SELECT record_key FROM ${f.table} WHERE connector_instance_id = $1 AND scope_key = $2`, [
                  f.instance,
                  '[ "items","body"]',
                ])
              ).length,
              1,
              "untrusted derived evidence has no deletion authority"
            );
          })
      );

    await t.test(
      "legacy NULL trailing orphan/removed field/empty canonical stream are deleted, with wildcard and other-instance siblings intact",
      async () =>
        fixture(async (f) => {
          await f.ingest("k1", "A");
          await f.repair();
          for (const stream of ["item_", "item%", "itemX"]) {
            await f.ingest("k1", stream, stream);
            await f.repair(stream);
          }
          const sibling = await f.rows("itemX");
          const otherInstance = `${f.instance}_sibling`;
          await ingestRecord(
            { connector_id: f.connector, connector_instance_id: otherInstance },
            record("items", "k1", "other instance"),
            { deferIndexes: true }
          );
          await semanticIndexBackfillForManifest({
            manifest: { ...f.pinned(), connector_instance_id: otherInstance },
            orphanStreamCleanup: false,
          });
          const otherRows = await f.sql(`SELECT input_identity FROM ${f.table} WHERE connector_instance_id = $1`, [
            otherInstance,
          ]);
          await f.ingest("k2", "second");
          await f.repair();
          // Empty and trailing index-only keys must both be visited.
          await f.sql(
            `UPDATE ${f.table} SET record_key = CASE WHEN record_key = 'k1' THEN '' ELSE $1 END, input_identity = NULL WHERE connector_instance_id = $2 AND scope_key = $3`,
            ["zz-orphan", f.instance, '["items","subject"]']
          );
          await f.sql("DELETE FROM records WHERE connector_instance_id = $1 AND stream = $2", [f.instance, "items"]);
          await f.repair();
          assert.deepEqual(await f.rows(), []);
          // A wildcard stream must not interpret '_'/'%' as LIKE syntax.
          for (const stream of ["item_", "item%"]) {
            await f.sql(
              `UPDATE ${f.table} SET input_identity = NULL, scope_key = $1 WHERE connector_instance_id = $2 AND scope_key = $3`,
              [JSON.stringify([stream, "removed"]), f.instance, JSON.stringify([stream, "subject"])]
            );
            await f.repair(stream);
            const removed = await f.sql(
              `SELECT record_key FROM ${f.table} WHERE connector_instance_id = $1 AND scope_key = $2`,
              [f.instance, JSON.stringify([stream, "removed"])]
            );
            assert.deepEqual(removed, []);
            assert.deepEqual(await f.rows("itemX"), sibling);
            assert.deepEqual(
              await f.sql(`SELECT input_identity FROM ${f.table} WHERE connector_instance_id = $1`, [otherInstance]),
              otherRows
            );
          }
        })
    );

    await t.test(
      "equal-cardinality wrong key/field and emptied field repair exact membership; legacy NULL refreshes only once",
      async () =>
        fixture(async (f) => {
          await f.ingest("k1", "A");
          await f.ingest("k2", "B");
          await f.repair();
          await f.sql(
            `UPDATE ${f.table} SET scope_key = $1, record_key = $2 WHERE connector_instance_id = $3 AND record_key = $4`,
            ['["items","wrong"]', "wrong-key", f.instance, "k2"]
          );
          await f.repair();
          assert.deepEqual(
            (await f.rows()).map((r) => r.record_key),
            ["k1", "k2"]
          );
          const calls = f.inputs.length;
          await f.sql(`UPDATE ${f.table} SET input_identity = NULL WHERE connector_instance_id = $1`, [f.instance]);
          await f.repair();
          assert.equal(f.inputs.length, calls + 2);
          const calls2 = f.inputs.length;
          await f.repair();
          assert.equal(f.inputs.length, calls2);
          await f.ingest("k1", "");
          await f.repair();
          assert.deepEqual(
            (await f.rows()).map((r) => r.record_key),
            ["k2"]
          );
        })
    );

    await t.test(
      "a failed later page/restart preserves all committed identities and performs no repeat embedding or index writes",
      async () =>
        fixture(async (f) => {
          // 501 records crosses the production page boundary, not a copied loop.
          for (let i = 0; i < 501; i++) await f.ingest(`k${i}`, `text-${i}`);
          let pages = 0;
          __setSemanticRepairPhaseHookForTest((phase) => {
            if (phase === "after-page-publish" && ++pages === 1) throw new Error("crash after committed page");
          });
          await assert.rejects(f.repair(), /crash after committed page/);
          const complete = await f.rows();
          assert.equal(complete.length, 500);
          const calls = f.inputs.length;
          __setSemanticRepairPhaseHookForTest(null);
          resetVectorIndexForTests(kind === "blob-flat" ? "blob-flat" : undefined);
          await f.repair();
          assert.equal(f.inputs.length, calls + 1);
          assert.equal((await f.rows()).length, 501);
          const dml = await f.writes(),
            calls2 = f.inputs.length;
          await f.repair();
          assert.equal(f.inputs.length, calls2);
          assert.equal(await f.writes(), dml);
        })
    );

    await t.test(
      "canonical change at delete barrier preserves current publication and its newer dirty generation",
      async () =>
        fixture(async (f) => {
          await f.ingest("k1", "A");
          await f.repair();
          await f.ingest("k1", "");
          let ran = false;
          __setSemanticRepairPhaseHookForTest(async (phase) => {
            if (phase !== "before-prune-page" || ran) return;
            ran = true;
            await f.ingest("k1", "resurrected");
          });
          await assert.rejects(f.repair(), /did not converge/);
          __setSemanticRepairPhaseHookForTest(null);
          assert.equal((await f.rows()).length, 1, "cleanup may not delete a now-live current input");
          await f.repair();
          assert.equal(f.inputs.at(-1), "resurrected");
        })
    );

    if (kind === "postgres")
      await t.test(
        "a separate PostgreSQL publisher holds the shared advisory lock; cleanup waits then preserves its resurrected current vector and dirty revision",
        async () =>
          fixture(async (f) => {
            await f.ingest("k1", "A");
            await f.repair();
            await f.ingest("k1", "");
            const scope = required(
              (await listDirtySearchIndexScopes(1000)).find((s) => s.connectorInstanceId === f.instance)
            );
            const computed = await computeSemanticEntries({
              connectorId: f.connector,
              connectorInstanceId: f.instance,
              stream: "items",
              recordKey: "k1",
              data: { id: "k1", subject: "peer-B" },
            });
            assert.ok(computed);
            let reached!: () => void, resume!: () => void;
            const atPrune = new Promise<void>((resolve) => {
              reached = resolve;
            });
            const resumePrune = new Promise<void>((resolve) => {
              resume = resolve;
            });
            let once = false;
            __setSemanticRepairPhaseHookForTest(async (phase) => {
              if (phase === "before-prune-page" && !once) {
                once = true;
                reached();
                await resumePrune;
              }
            });
            const repair = reconcileSearchIndexDirtyScope(scope);
            await atPrune;
            const pool = new pg.Pool({
              connectionString: process.env.PDPP_TEST_POSTGRES_URL,
            });
            const peer = await pool.connect();
            try {
              await peer.query("BEGIN");
              await peer.query("SELECT pg_advisory_xact_lock($1::bigint)", [
                connectorInstanceAdvisoryLockKey(f.instance),
              ]);
              await peer.query(
                "UPDATE records SET version = version + 1, record_json = $1 WHERE connector_instance_id = $2 AND stream = 'items' AND record_key = 'k1'",
                [{ id: "k1", subject: "peer-B" }, f.instance]
              );
              await peer.query(
                "UPDATE search_index_dirty SET dirty = 1, revision = revision + 1 WHERE connector_instance_id = $1 AND stream = 'items'",
                [f.instance]
              );
              await applySemanticEntriesWithClient(peer, {
                connectorId: f.connector,
                connectorInstanceId: f.instance,
                stream: "items",
                recordKey: "k1",
                computed,
              });
              resume();
              let waited = false;
              for (let attempt = 0; attempt < 100; attempt++) {
                const locks = await peer.query(
                  "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())"
                );
                if (locks.rowCount) {
                  waited = true;
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              assert.equal(
                waited,
                true,
                "the repair must wait for the SQL transaction lock, independently of its local coordinator"
              );
              await peer.query("COMMIT");
              const result = await repair;
              assert.equal(result.outcome, "recontended");
              assert.equal((await f.rows()).length, 1);
              assert.ok(
                (await listDirtySearchIndexScopes(1000)).some(
                  (s) => s.connectorInstanceId === f.instance && s.revision > scope.revision
                )
              );
              const calls = f.inputs.length;
              await f.repair();
              assert.equal(f.inputs.length, calls);
            } finally {
              resume();
              await peer.query("ROLLBACK");
              peer.release();
              await pool.end();
              await repair;
            }
          })
      );

    if (kind === "postgres")
      await t.test(
        "default removed-stream cleanup fails closed when the stream is reintroduced before its fenced page",
        async () =>
          fixture(async (f) => {
            await f.ingest("k1", "old");
            await f.repair();
            const removedManifest = {
              ...f.pinned(),
              streams: f.manifest.streams.filter((stream) => stream.name !== "items"),
            };
            await registerConnector(removedManifest, { backfillRetrievalIndexes: false });
            let reintroduced = false;
            const parentPid = Number(required((await f.sql("SELECT pg_backend_pid() AS n"))[0]).n);
            __setSemanticRepairPhaseHookForTest(async (phase) => {
              if (phase !== "before-orphan-prune" || reintroduced) return;
              reintroduced = true;
              const childPid = await reintroduceStreamFromFreshPostgresProcess({
                manifest: f.pinned(),
                connectorInstanceId: f.instance,
                childAttachment: required(f.childAttachment),
              });
              assert.notEqual(childPid, parentPid, "the reintroduction must use a separate PostgreSQL session");
            });
            await assert.rejects(
              semanticIndexBackfillForManifest({ manifest: removedManifest }),
              /reintroduced during derived repair/
            );
            assert.equal(reintroduced, true);
            assert.equal((await f.rows()).length, 1, "current publication survives the stale removed-stream cleanup");
          })
      );

    await t.test(
      "missing persisted manifest and activation retain removed-stream index state and dirty revision",
      async () =>
        fixture(async (f) => {
          await f.ingest("k1", "retained");
          await f.repair();
          await f.sql(
            `INSERT INTO semantic_search_backfill_progress(
               connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at
             )
             SELECT connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at
             FROM semantic_search_meta WHERE connector_id = $1 AND stream = 'items'`,
            [f.connector]
          );
          await f.sql("DELETE FROM connectors WHERE connector_id = $1", [f.connector]);
          assert.equal(
            (await f.sql("SELECT 1 FROM connector_activations WHERE connector_id = $1", [f.connector])).length,
            0,
            "this models a native declared-stream connector with neither registry nor activation authority"
          );
          await f.ingest("k2", "declared native stream remains ingestable without registry metadata");
          const beforeRows = await f.rows();
          const beforeMeta = await f.sql(
            "SELECT * FROM semantic_search_meta WHERE connector_id = $1 AND stream = 'items'",
            [f.connector]
          );
          const beforeProgress = await f.sql(
            "SELECT * FROM semantic_search_backfill_progress WHERE connector_id = $1 AND stream = 'items'",
            [f.connector]
          );
          const beforeDirty = required(
            (
              await f.sql(
                "SELECT revision, dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'items'",
                [f.instance]
              )
            )[0]
          );
          const dirtyScope = required(
            (await listDirtySearchIndexScopes(1000)).find((candidate) => candidate.connectorInstanceId === f.instance)
          );
          const removedManifest = {
            ...f.manifest,
            streams: f.manifest.streams.filter((stream) => stream.name !== "items"),
          };
          await assert.rejects(
            semanticIndexBackfillForManifest({ manifest: removedManifest }),
            /manifest is unavailable/,
            "absence of both authority rows must not authorize removed-stream deletion"
          );
          assert.equal(
            (await reconcileSearchIndexDirtyScope(dirtyScope)).outcome,
            "failed",
            "missing persisted manifest leaves native declared-stream repair dirty"
          );

          assert.deepEqual(await f.rows(), beforeRows, "derived index rows remain available");
          assert.deepEqual(
            await f.sql("SELECT * FROM semantic_search_meta WHERE connector_id = $1 AND stream = 'items'", [
              f.connector,
            ]),
            beforeMeta,
            "semantic metadata remains available"
          );
          assert.deepEqual(
            await f.sql(
              "SELECT * FROM semantic_search_backfill_progress WHERE connector_id = $1 AND stream = 'items'",
              [f.connector]
            ),
            beforeProgress,
            "semantic progress remains available"
          );
          assert.deepEqual(
            required(
              (
                await f.sql(
                  "SELECT revision, dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'items'",
                  [f.instance]
                )
              )[0]
            ),
            beforeDirty,
            "the existing dirty revision remains unchanged"
          );
        })
    );

    if (kind === "postgres")
      await t.test(
        "PostgreSQL C-collated candidate pages are complete, ordered, and bounded by the matching index",
        async () =>
          fixture(async (f) => {
            await f.sql(
              `INSERT INTO semantic_search_blob(connector_instance_id,connector_id,scope_key,record_key,embedding,input_identity)
             SELECT $1,$2,CASE WHEN n < 501 THEN '["items","subject"]' ELSE '["sibling_' || n || '","subject"]' END,
                    CASE WHEN n < 501 THEN 'k' || lpad(n::text, 4, '0') ELSE 'sibling-key' END,
                    '[0,0,0,0,0,0,0,0]'::vector,'candidate'
             FROM generate_series(0, 20000) AS n`,
              [f.instance, f.connector]
            );
            await f.sql("ANALYZE semantic_search_blob");

            const first = await postgresSemanticIndexCandidatesPage({
              connectorInstanceId: f.instance,
              stream: "items",
              after: null,
            });
            assert.equal(first.length, 500, "the first candidate page stops at 500");
            const lastCandidate = required(first.at(-1));
            const continuation = await postgresSemanticIndexCandidatesPage({
              connectorInstanceId: f.instance,
              stream: "items",
              after: { scope_key: lastCandidate.scope_key, record_key: lastCandidate.record_key },
            });
            assert.equal(continuation.length, 1, "the continuation returns the one remaining candidate");
            const all = [...first, ...continuation];
            assert.deepEqual(
              all.map((row) => row.record_key),
              Array.from({ length: 501 }, (_, index) => `k${String(index).padStart(4, "0")}`),
              "first and continuation pages return the complete C-ordered set without gaps or duplicates"
            );

            const plan = required(
              (
                await f.sql(
                  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
               WITH page AS MATERIALIZED (
                 SELECT scope_key, record_key, input_identity, xmin::text AS index_version
                 FROM semantic_search_blob
                 WHERE connector_instance_id = $1
                   AND scope_key COLLATE "C" >= $2 AND scope_key COLLATE "C" < $3
                   AND ($4::text IS NULL OR (scope_key COLLATE "C", record_key COLLATE "C") > ($4::text, $5::text))
                 ORDER BY scope_key COLLATE "C", record_key COLLATE "C" LIMIT 500
               )
               SELECT p.*, r.record_json, r.version, r.deleted, TRUE AS vector_exists
               FROM page p LEFT JOIN LATERAL (
                 SELECT record_json, version, deleted FROM records
                 WHERE connector_instance_id = $1 AND stream = $6 AND record_key = p.record_key LIMIT 1
               ) r ON TRUE
               ORDER BY p.scope_key COLLATE "C", p.record_key COLLATE "C"`,
                  [f.instance, '["items",', '["items"-', null, null, "items"]
                )
              )[0]
            );
            const explain = (plan as unknown as { "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> })[
              "QUERY PLAN"
            ][0];
            assert.ok(explain, "EXPLAIN ANALYZE returns a query plan");
            const nodes: Record<string, unknown>[] = [];
            const visit = (node: Record<string, unknown>) => {
              nodes.push(node);
              for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) visit(child);
            };
            visit(explain.Plan);
            const candidateIndex = nodes.find((node) => node["Index Name"] === "idx_pg_semantic_search_scope_c");
            assert.ok(
              candidateIndex,
              `candidate discovery uses the C-collated composite index; plan=${JSON.stringify(explain.Plan)}`
            );
            const pageLimit = nodes.find((node) => node["Node Type"] === "Limit");
            assert.ok(pageLimit, "candidate discovery has an explicit page limit");
            assert.ok(Number(pageLimit["Actual Rows"]) <= 500, "the candidate page is capped at 500 rows");
            assert.ok(
              Number(candidateIndex["Actual Rows"]) <= 501,
              "the C-index scan reads at most the page plus boundary row"
            );
            assert.ok(
              Number(candidateIndex["Shared Hit Blocks"] ?? 0) + Number(candidateIndex["Shared Read Blocks"] ?? 0) > 0,
              "EXPLAIN BUFFERS reports storage work for the bounded candidate scan"
            );
          })
      );

    if (kind === "postgres")
      await t.test("candidate discovery uses one exact-scope statement while the instance lock is held", async () =>
        fixture(async (f) => {
          const siblingScopes = Array.from({ length: 600 }, (_, index) =>
            JSON.stringify([`aaa-sibling-${String(index).padStart(4, "0")}`, "subject"])
          );
          await f.sql(
            `INSERT INTO semantic_search_blob(connector_instance_id,connector_id,scope_key,record_key,embedding,input_identity)
             SELECT $1, $2, scope_key, 'sibling', '[0,0,0,0,0,0,0,0]'::vector, 'orphan'
             FROM unnest($3::text[]) AS scopes(scope_key)`,
            [f.instance, f.connector, siblingScopes]
          );
          await f.ingest("target", "current");
          await f.repair();
          let statements = 0;
          const page = await withPostgresBulkTransaction(
            async (client) => {
              const countedClient = {
                query: (...args: Parameters<typeof client.query>) => {
                  statements += 1;
                  return client.query(...args);
                },
              } as typeof client;
              return postgresSemanticIndexCandidatesPage({
                connectorInstanceId: f.instance,
                stream: "items",
                after: null,
                client: countedClient,
              });
            },
            { lockConnectorInstanceId: f.instance }
          );
          assert.equal(page.length, 1);
          assert.ok(statements <= 1, `scope discovery issued ${statements} statements while holding the instance lock`);
        })
      );

    await t.test(
      "a canonical update during embedding fences the old vector and preserves the newer dirty generation",
      async () =>
        fixture(async (f) => {
          await f.ingest("k1", "A");
          await f.repair();
          const before = await f.vector();
          await f.ingest("k1", "B");
          const observed = required(
            (await listDirtySearchIndexScopes(1000)).find((s) => s.connectorInstanceId === f.instance)
          );
          let changed = false;
          configureSemanticBackend({
            ...f.embedding,
            embedDocument: async (text) => {
              if (!changed) {
                changed = true;
                await f.ingest("k1", "C");
              }
              return f.embedding.embedDocument(text);
            },
          });
          const result = await reconcileSearchIndexDirtyScope(observed);
          assert.equal(result.outcome, "failed");
          assert.deepEqual(await f.vector(), before, "B cannot overwrite a row whose canonical version advanced to C");
          const newer = required(
            (
              await f.sql(
                "SELECT revision, dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'items'",
                [f.instance]
              )
            )[0]
          );
          assert.ok(Number(newer.revision) > observed.revision);
          assert.equal(newer.dirty, 1);
          configureSemanticBackend(f.embedding);
          await f.repair();
          assert.equal(f.inputs.at(-1), "C");
        })
    );

    await t.test("rollback invalidation leaves legacy vector unknown and forces revalidation on re-upgrade", async () =>
      fixture(async (f) => {
        await f.ingest("k1", "A");
        await f.repair();
        const before = await f.vector();
        // Supported old-writer cutover: quiesce upgraded writers, invalidate,
        // then let the old binary write. Never trust an unchanged old digest.
        await f.sql(`UPDATE ${f.table} SET input_identity = NULL WHERE connector_instance_id = $1`, [f.instance]);
        const oldVector = new Float32Array(8).fill(0.25);
        if (kind === "sqlite-vec")
          await f.sql(
            "UPDATE semantic_search_vec SET embedding = $1 WHERE rowid = (SELECT rowid FROM semantic_search_rowid WHERE connector_instance_id = $2)",
            [Buffer.from(oldVector.buffer), f.instance]
          );
        else
          await f.sql(`UPDATE ${f.table} SET embedding = $1 WHERE connector_instance_id = $2`, [
            kind === "postgres" ? JSON.stringify([...oldVector]) : Buffer.from(oldVector.buffer),
            f.instance,
          ]);
        const calls = f.inputs.length;
        resetVectorIndexForTests(kind === "blob-flat" ? "blob-flat" : undefined);
        await f.repair();
        assert.equal(f.inputs.length, calls + 1);
        assert.deepEqual(await f.vector(), before);
      })
    );

    await t.test("normal ingest maintenance rejects a manifest change during unlocked embedding", async () =>
      fixture(async (f) => {
        await f.ingest("k1", "A");
        await f.repair();
        await f.ingest("k1", "B");
        const version = Number(
          required(
            (
              await f.sql(
                "SELECT version FROM records WHERE connector_instance_id = $1 AND stream = 'items' AND record_key = 'k1'",
                [f.instance]
              )
            )[0]
          ).version
        );
        const before = await f.vector();
        configureSemanticBackend({
          ...f.embedding,
          embedDocument: async (text) => {
            await registerConnector(
              {
                ...f.manifest,
                streams: f.manifest.streams.map((s) => ({ ...s, query: { search: { semantic_fields: ["id"] } } })),
              },
              { backfillRetrievalIndexes: false }
            );
            return f.embedding.embedDocument(text);
          },
        });
        await assert.rejects(
          maintainRecordIndexes(
            { connector_id: f.connector, connector_instance_id: f.instance },
            record("items", "k1", "B"),
            version
          ),
          /manifest.*changed/
        );
        assert.deepEqual(await f.vector(), before, "a stale manifest cannot publish B's vector");
        assert.equal(
          Number(
            required(
              (
                await f.sql(
                  "SELECT dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'items'",
                  [f.instance]
                )
              )[0]
            ).dirty
          ),
          1
        );
      })
    );

    await t.test(
      "backend/config or manifest replacement during unlocked embedding rejects stale publication",
      async () =>
        fixture(async (f) => {
          await f.ingest("k1", "A");
          await f.repair();
          await f.ingest("k1", "B");
          configureSemanticBackend({
            ...f.embedding,
            embedDocument: async (text) => {
              configureSemanticBackend(makeStubBackend({ dimensions: 8 }));
              return f.embedding.embedDocument(text);
            },
          });
          await assert.rejects(f.repair(), /backend changed/);
          assert.equal((await f.rows()).length, 1);
          configureSemanticBackend(f.embedding);
          await f.repair();
          await f.ingest("k1", "C");
          let changed = false;
          configureSemanticBackend({
            ...f.embedding,
            embedDocument: async (text) => {
              if (!changed) {
                changed = true;
                await registerConnector(
                  {
                    ...f.manifest,
                    streams: f.manifest.streams.map((s) => ({
                      ...s,
                      query: { search: { semantic_fields: ["id"] } },
                    })),
                  },
                  { backfillRetrievalIndexes: false }
                );
              }
              return f.embedding.embedDocument(text);
            },
          });
          await assert.rejects(f.repair(), /manifest.*changed/);
        })
    );

    await t.test("a manifest or backend change after verification cannot clear dirty", async () =>
      fixture(async (f) => {
        await f.ingest("k1", "A");
        await f.repair();
        await f.ingest("k1", "B");
        let observed = required(
          (await listDirtySearchIndexScopes(1000)).find((s) => s.connectorInstanceId === f.instance)
        );
        let once = false;
        __setSemanticRepairPhaseHookForTest(async (phase) => {
          if (phase === "after-verification" && !once) {
            once = true;
            await registerConnector(
              {
                ...f.manifest,
                streams: f.manifest.streams.map((s) => ({ ...s, query: { search: { semantic_fields: ["id"] } } })),
              },
              { backfillRetrievalIndexes: false }
            );
          }
        });
        assert.equal((await reconcileSearchIndexDirtyScope(observed)).outcome, "failed");
        __setSemanticRepairPhaseHookForTest(null);
        await registerConnector(f.manifest, { backfillRetrievalIndexes: false });
        await f.ingest("k1", "C");
        observed = required((await listDirtySearchIndexScopes(1000)).find((s) => s.connectorInstanceId === f.instance));
        __setSemanticRepairPhaseHookForTest((phase) => {
          if (phase === "after-verification") configureSemanticBackend({ ...f.embedding });
        });
        assert.equal((await reconcileSearchIndexDirtyScope(observed)).outcome, "failed");
        const dirty = required(
          (
            await f.sql("SELECT dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'items'", [
              f.instance,
            ])
          )[0]
        );
        assert.equal(dirty.dirty, 1);
      })
    );

    await t.test(
      "nonsemantic edits and normalized truncation reuse exact input; model identity change invalidates reuse",
      async () =>
        fixture(async (f) => {
          const long = "x".repeat(9000);
          await f.ingest("k1", long, "items", { other: "a" });
          await f.repair();
          const before = await f.vector(),
            calls = f.inputs.length;
          await f.ingest("k1", `${long}beyond truncation`, "items", {
            other: "b",
          });
          const dml = await f.writes();
          await semanticIndexUpsert({
            connectorId: f.connector,
            connectorInstanceId: f.instance,
            stream: "items",
            recordKey: "k1",
            data: { id: "k1", subject: `${long}beyond truncation`, other: "b" },
          });
          assert.equal(f.inputs.length, calls);
          assert.equal(await f.writes(), dml, "live compute/apply must also retain an unchanged normalized input");
          await f.repair();
          assert.equal(f.inputs.length, calls);
          assert.deepEqual(await f.vector(), before);
          const b = f.embedding;
          const storageIdentity = `model=${b.model()};dimensions=${b.dimensions()};metric=${b.distanceMetric()};profile=${b.profileId()}`;
          const legacyPreprocessing = createHash("sha256")
            .update(
              JSON.stringify([
                "semantic-input-v1",
                "nonempty-prefix-v0",
                DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS,
                storageIdentity,
                long.slice(0, DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS),
              ])
            )
            .digest("hex");
          await f.sql(`UPDATE ${f.table} SET input_identity = $1 WHERE connector_instance_id = $2`, [
            legacyPreprocessing,
            f.instance,
          ]);
          await f.repair();
          assert.equal(f.inputs.length, calls + 1, "preprocessing version is part of source identity");
          for (const changedBackend of [
            { ...f.embedding, model: () => "replacement-model" },
            { ...f.embedding, profileId: () => "replacement-profile" },
            { ...f.embedding, dtype: () => "replacement-dtype" },
          ]) {
            configureSemanticBackend(changedBackend);
            await f.repair();
          }
          assert.equal(f.inputs.length, calls + 4, "each storage backend contract change invalidates old inputs");
        })
    );

    if (kind !== "postgres")
      await t.test(
        "SQLite additive and instance-table recreation migrations preserve proven identities; old NULL vectors refresh once",
        async () =>
          fixture(async (f) => {
            const dir = mkdtempSync(path.join(tmpdir(), "index391-semantic-migration-"));
            const dbPath = path.join(dir, "fixture.sqlite");
            try {
              closeDb();
              initDb(dbPath);
              resetVectorIndexForTests(kind === "blob-flat" ? "blob-flat" : undefined);
              await registerConnector(f.manifest, {
                backfillRetrievalIndexes: false,
              });
              await f.ingest("k1", "A");
              await f.repair();
              const proven = await f.rows();
              getDb().exec(`DROP TABLE semantic_search_backfill_progress;
          CREATE TABLE semantic_search_backfill_progress (
            connector_id TEXT NOT NULL, stream TEXT NOT NULL, fields_fingerprint TEXT NOT NULL,
            model_id TEXT NOT NULL, dimensions INTEGER NOT NULL, distance_metric TEXT NOT NULL,
            updated_at TEXT NOT NULL, PRIMARY KEY(connector_id, stream));`);
              closeDb();
              initDb(dbPath);
              resetVectorIndexForTests(kind === "blob-flat" ? "blob-flat" : undefined);
              assert.deepEqual(
                await f.rows(),
                proven,
                "recreation/copy must retain identities already published with their vectors"
              );
              const calls = f.inputs.length;
              await f.repair();
              assert.equal(f.inputs.length, calls);
              getDb().exec(`ALTER TABLE ${f.table} DROP COLUMN input_identity`);
              closeDb();
              initDb(dbPath);
              resetVectorIndexForTests(kind === "blob-flat" ? "blob-flat" : undefined);
              assert.equal(
                required((await f.rows())[0]).input_identity,
                null,
                "additive migration may not guess a legacy identity"
              );
              await f.repair();
              assert.equal(f.inputs.length, calls + 1);
              await f.repair();
              assert.equal(f.inputs.length, calls + 1);
            } finally {
              closeDb();
              rmSync(dir, { recursive: true, force: true });
            }
          })
      );

    if (kind !== "postgres")
      await t.test("a rowid reused by a healthy sibling between candidate read and delete survives", async () =>
        fixture(async (f) => {
          await f.ingest("k1", "A");
          await f.repair();
          await f.ingest("k1", "");
          const candidate = required(
            (
              await f.sql(`SELECT rowid, input_identity FROM ${f.table} WHERE connector_instance_id = $1`, [f.instance])
            )[0]
          );
          let once = false;
          __setSemanticRepairPhaseHookForTest(async (phase) => {
            if (phase !== "before-prune-page" || once) return;
            once = true;
            await f.ingest("sibling", "healthy", "itemX");
            const vector = await f.embedding.embedDocument("healthy");
            if (kind !== "sqlite-vec") {
              await f.sql(`DELETE FROM ${f.table} WHERE connector_instance_id = $1 AND record_key = 'k1'`, [
                f.instance,
              ]);
            }
            if (kind === "sqlite-vec") {
              await f.sql("DELETE FROM semantic_search_vec WHERE rowid = $1", [candidate.rowid]);
              await f.sql(
                "INSERT INTO semantic_search_vec(rowid,connector_instance_id,connector_id,scope_key,record_key,embedding) VALUES($1,$2,$3,$4,$5,$6)",
                [
                  BigInt(candidate.rowid),
                  f.instance,
                  f.connector,
                  '["itemX","subject"]',
                  "sibling",
                  Buffer.from(vector.buffer),
                ]
              );
              await f.sql(
                `INSERT INTO ${f.table}(rowid,connector_instance_id,connector_id,scope_key,record_key,input_identity) VALUES($1,$2,$3,$4,$5,$6)`,
                [candidate.rowid, f.instance, f.connector, '["itemX","subject"]', "sibling", candidate.input_identity]
              );
            } else
              await f.sql(
                `INSERT INTO ${f.table}(rowid,connector_instance_id,connector_id,scope_key,record_key,embedding,input_identity) VALUES($1,$2,$3,$4,$5,$6,$7)`,
                [
                  candidate.rowid,
                  f.instance,
                  f.connector,
                  '["itemX","subject"]',
                  "sibling",
                  Buffer.from(vector.buffer),
                  candidate.input_identity,
                ]
              );
          });
          await f.repair();
          assert.equal(once, true);
          assert.equal(
            (await f.rows("itemX")).length,
            1,
            "an old candidate's rowid is not a deletion authority for a sibling"
          );
          if (kind === "sqlite-vec")
            assert.equal(
              (await f.sql("SELECT rowid FROM semantic_search_vec WHERE rowid = $1", [candidate.rowid])).length,
              1
            );
        })
      );

    if (kind === "sqlite-vec")
      await t.test("a physical vec0 row with no sidecar is removed during repair", async () =>
        fixture(async (f) => {
          await f.ingest("k1", "current");
          await f.repair();
          const staleVector = await f.embedding.embedDocument("stale physical duplicate");
          await f.sql(
            "INSERT INTO semantic_search_vec(connector_instance_id,connector_id,scope_key,record_key,embedding) VALUES($1,$2,$3,$4,$5)",
            [f.instance, f.connector, '["items","subject"]', "k1", Buffer.from(staleVector.buffer)]
          );
          assert.equal(
            (
              await f.sql(
                "SELECT rowid FROM semantic_search_vec WHERE connector_instance_id = $1 AND scope_key = $2 AND record_key = $3",
                [f.instance, '["items","subject"]', "k1"]
              )
            ).length,
            2,
            "the fixture has both the healthy owned vector and a physical orphan"
          );
          await f.repair();
          assert.equal(
            (
              await f.sql(
                "SELECT rowid FROM semantic_search_vec WHERE connector_instance_id = $1 AND scope_key = $2 AND record_key = $3",
                [f.instance, '["items","subject"]', "k1"]
              )
            ).length,
            1,
            "repair must enumerate and remove a physical vector that has no sidecar"
          );
        })
      );

    if (kind === "sqlite-vec")
      await t.test(
        "vec0 TEMP inventory INSERT and DROP faults clean tables and always release the active job",
        async () =>
          fixture(async (f) => {
            try {
              await f.ingest("k1", "inventory lifecycle");
              let injectInsertFailure = true;
              __setSemanticVecInventoryFaultHookForTest((phase) => {
                if (phase === "before-insert" && injectInsertFailure) {
                  injectInsertFailure = false;
                  throw new Error("injected inventory INSERT fault");
                }
              });
              await assert.rejects(f.repair(), /injected inventory INSERT fault/);
              assert.deepEqual(
                getDb()
                  .prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'semantic_repair_vec_inventory_%'")
                  .all(),
                [],
                "a failed capture INSERT drops the TEMP table created immediately before it"
              );
              assert.equal(isSemanticIndexBackfillActive(), false, "INSERT failure releases active job admission");
              assert.equal(getSemanticIndexBackfillProgress(), null, "INSERT failure removes its visible job record");

              __setSemanticVecInventoryFaultHookForTest(null);
              await f.repair();
              assert.equal((await f.rows()).length, 1, "a fresh inventory retry converges");

              let injectDropFailure = true;
              __setSemanticVecInventoryFaultHookForTest((phase) => {
                if (phase === "before-drop" && injectDropFailure) {
                  injectDropFailure = false;
                  throw new Error("injected inventory DROP fault");
                }
              });
              await assert.rejects(f.repair(), /injected inventory DROP fault/);
              assert.deepEqual(
                getDb()
                  .prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'semantic_repair_vec_inventory_%'")
                  .all(),
                [],
                "one failed DROP is retried so no TEMP table is stranded"
              );
              assert.equal(isSemanticIndexBackfillActive(), false, "DROP failure releases active job admission");
              assert.equal(getSemanticIndexBackfillProgress(), null, "DROP failure removes its visible job record");
              __setSemanticVecInventoryFaultHookForTest(null);
              await f.repair();
              assert.equal((await f.rows()).length, 1, "a retry after DROP failure remains healthy");
            } finally {
              __setSemanticVecInventoryFaultHookForTest(null);
            }
          })
      );

    if (kind === "sqlite-vec")
      await t.test(
        "a vec0-only orphan with no canonical record is not mistaken for an empty healthy stream",
        async () =>
          fixture(async (f) => {
            await f.repair();
            const staleVector = await f.embedding.embedDocument("orphan without record or sidecar");
            await f.sql(
              "INSERT INTO semantic_search_vec(connector_instance_id,connector_id,scope_key,record_key,embedding) VALUES($1,$2,$3,$4,$5)",
              [f.instance, f.connector, '[\"items\",\"subject\"]', "orphan", Buffer.from(staleVector.buffer)]
            );
            await f.repair();
            assert.equal(
              (
                await f.sql(
                  "SELECT rowid FROM semantic_search_vec WHERE connector_instance_id = $1 AND scope_key = $2 AND record_key = $3",
                  [f.instance, '[\"items\",\"subject\"]', "orphan"]
                )
              ).length,
              0,
              "the no-record path still inventories and removes a physical-only orphan"
            );
          })
      );

    if (kind === "sqlite-vec")
      await t.test("physical vec0 duplicates cross a page without collapsing tuple or cursor identity", async () =>
        fixture(async (f) => {
          await f.ingest("k1", "current");
          await f.repair();
          const staleVector = await f.embedding.embedDocument("stale physical duplicate");
          // 501 same-tuple rows cross the 500-entry page boundary. Every
          // physical row needs a distinct observation key *and* the outer
          // result order needs the full cursor tuple for page.at(-1).
          for (let orphan = 0; orphan < 501; orphan++) {
            await f.sql(
              "INSERT INTO semantic_search_vec(connector_instance_id,connector_id,scope_key,record_key,embedding) VALUES($1,$2,$3,$4,$5)",
              [f.instance, f.connector, '[\"items\",\"subject\"]', "k1", Buffer.from(staleVector.buffer)]
            );
          }
          // A second obsolete logical tuple proves the repair is not merely
          // deleting all but the original healthy row.
          for (let orphan = 0; orphan < 2; orphan++) {
            await f.sql(
              "INSERT INTO semantic_search_vec(connector_instance_id,connector_id,scope_key,record_key,embedding) VALUES($1,$2,$3,$4,$5)",
              [f.instance, f.connector, '[\"items\",\"subject\"]', "obsolete", Buffer.from(staleVector.buffer)]
            );
          }
          assert.equal(
            (
              await f.sql(
                "SELECT rowid FROM semantic_search_vec WHERE connector_instance_id = $1 AND scope_key = $2 AND record_key = $3",
                [f.instance, '[\"items\",\"subject\"]', "k1"]
              )
            ).length,
            502,
            "the fixture has one healthy vector plus 501 independent physical orphans"
          );
          await f.repair();
          assert.equal(
            (
              await f.sql(
                "SELECT rowid FROM semantic_search_vec WHERE connector_instance_id = $1 AND scope_key = $2 AND record_key = $3",
                [f.instance, '[\"items\",\"subject\"]', "k1"]
              )
            ).length,
            1,
            "repair must not collapse multiple physical rowids at the same logical tuple"
          );
          assert.equal(
            (
              await f.sql(
                "SELECT rowid FROM semantic_search_vec WHERE connector_instance_id = $1 AND scope_key = $2 AND record_key = $3",
                [f.instance, '[\"items\",\"subject\"]', "obsolete"]
              )
            ).length,
            0,
            "the obsolete tuple is also removed rather than being hidden behind the duplicate tuple"
          );
          assert.deepEqual(
            getDb()
              .prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'semantic_repair_vec_inventory_%'")
              .all(),
            [],
            "the metadata-only inventory is dropped when the repair returns"
          );
          const calls = f.inputs.length;
          const writes = await f.writes();
          const sqliteChanges = getDb().prepare("SELECT total_changes() AS n").get<{ n: number }>()?.n;
          await f.repair();
          assert.equal(f.inputs.length, calls, "a converged physical inventory does not re-embed the healthy row");
          assert.equal(await f.writes(), writes, "the next repair does not mutate semantic sidecars");
          assert.equal(
            getDb().prepare("SELECT total_changes() AS n").get<{ n: number }>()?.n,
            (sqliteChanges ?? 0) + 1,
            "the only second-pass write is one transient metadata inventory row"
          );
        })
      );

    if (kind === "postgres")
      await t.test("PostgreSQL additive migration leaves legacy vectors unknown and refreshes them once", async () =>
        fixture(async (f) => {
          await f.ingest("k1", "A");
          await f.repair();
          await f.sql("DELETE FROM records WHERE connector_instance_id = $1", [f.instance]);
          await f.sql("ALTER TABLE semantic_search_blob DROP COLUMN input_identity");
          await closePostgresStorage();
          await initPostgresStorage({
            backend: "postgres",
            databaseUrl: process.env.PDPP_TEST_POSTGRES_URL as string,
          });
          assert.equal(required((await f.rows())[0]).input_identity, null);
          await f.ingest("k1", "A");
          const calls = f.inputs.length;
          await f.repair();
          assert.equal(f.inputs.length, calls + 1);
          await f.repair();
          assert.equal(f.inputs.length, calls + 1);
        })
      );

    await t.test(
      "missing vec0 vector is rebuilt; vector plus identity rollback is atomic on publication error",
      async () =>
        fixture(async (f) => {
          await f.ingest("k1", "A");
          await f.repair();
          if (kind === "sqlite-vec") {
            const row = required(
              (await f.sql(`SELECT rowid FROM ${f.table} WHERE connector_instance_id = $1`, [f.instance]))[0]
            );
            await f.sql("DELETE FROM semantic_search_vec WHERE rowid = $1", [row.rowid]);
            const calls = f.inputs.length;
            await f.repair();
            assert.equal(f.inputs.length, calls + 1);
            assert.ok(await f.vector(), "a sidecar alone must not pass verification");
          }
          const before = await f.vector(),
            identities = await f.rows();
          await f.ingest("k1", "B");
          if (kind !== "postgres") {
            getDb().exec(
              `CREATE TRIGGER fail_identity BEFORE UPDATE OF input_identity ON ${f.table} BEGIN SELECT RAISE(ABORT, 'identity publication failure'); END;`
            );
          } else {
            await f.sql(
              "CREATE OR REPLACE FUNCTION semantic_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'identity publication failure'; END $$"
            );
            await f.sql(
              `CREATE TRIGGER fail_identity BEFORE UPDATE OF input_identity ON ${f.table} FOR EACH ROW EXECUTE FUNCTION semantic_test_fail()`
            );
          }
          await assert.rejects(f.repair(), /identity publication failure/);
          assert.deepEqual(await f.vector(), before);
          assert.deepEqual(await f.rows(), identities);
          if (kind !== "postgres") getDb().exec("DROP TRIGGER fail_identity");
          else await f.sql(`DROP TRIGGER fail_identity ON ${f.table}`);
          await f.repair();
          assert.notDeepEqual(await f.vector(), before);
        })
    );
  });
}
