// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";
import { registerConnector } from "../server/auth.ts";
import { withConnectorInstanceControlPlaneWrite } from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { LocalTransformerExecutorError } from "../server/local-transformer-executor.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { ingestRecord } from "../server/records.ts";
import { runSearchIndexDirtyReconcileRound } from "../server/search-index-reconcile.ts";
import { computeSemanticEntries, makeStubBackend } from "../server/search-semantic.ts";
import { queueStartupSearchIndexRetry } from "../server/startup-search-index-retry.ts";
import { bumpStorageGeneration, currentStorageGeneration } from "../server/storage-generation.ts";
import {
  clearSearchIndexDirty,
  listDirtySearchIndexScopes,
  markStartupSearchIndexFailure,
} from "../server/stores/search-index-dirty-store.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";

const RETAINED_PG_TABLES = [
  "semantic_search_blob",
  "semantic_search_meta",
  "semantic_search_backfill_progress",
  "lexical_search_index",
  "lexical_search_meta",
  "search_index_dirty",
  "records",
];

/** Rows a finished test leaves in the shared database would make the next restart a no-op. */
async function clearRetainedPgState() {
  for (const table of RETAINED_PG_TABLES) {
    // biome-ignore lint/performance/noAwaitInLoops: Cleanup order is fixed and tiny.
    await postgresQuery(`DELETE FROM ${table}`);
  }
}

const STALE_GENERATION = /storage generation changed/;

function required<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}

const manifest = {
  connector_id: "startup-retry",
  display_name: "Startup retry",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      query: { search: { semantic_fields: ["subject"] } },
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
  manifest_uri: "https://example.test/startup-retry",
};

test("actual startup timeout queues retained work and maintenance converges without ingest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "startup-retry-"));
  const dbPath = join(dir, "db.sqlite");
  let healthy = false;
  let failedCalls = 0;
  const stub = makeStubBackend();
  const backend = {
    ...stub,
    embedDocument: async (text: string) => {
      if (!healthy) {
        failedCalls += 1;
        throw new LocalTransformerExecutorError("transformer_deadline");
      }
      return await stub.embedDocument(text);
    },
  };
  const pg = Boolean(process.env.PDPP_TEST_POSTGRES_URL);
  if (pg) {
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: process.env.PDPP_TEST_POSTGRES_URL || "",
    });
  } else {
    initDb(dbPath);
  }
  const attachment = pg
    ? await createAlreadyAdmittedTestDatabaseChildAttachment(process.env.PDPP_TEST_POSTGRES_URL || "")
    : undefined;
  await registerConnector(manifest, { backfillRetrievalIndexes: false });
  await ingestRecord(
    {
      connector_id: manifest.connector_id,
      connector_instance_id: "cin_startup_retry",
    },
    {
      data: { id: "k1", subject: "retained synthetic subject" },
      emitted_at: "2026-07-16T00:00:00.000Z",
      key: "k1",
      stream: "items",
    },
    { deferIndexes: true }
  );
  if (pg) {
    await postgresQuery("DELETE FROM search_index_dirty");
  } else {
    getDb().prepare("DELETE FROM search_index_dirty").run();
    closeDb();
  }
  const server = await startServer({
    asPort: 0,
    dbPath,
    rsPort: 0,
    storageBackend: pg ? "postgres" : "sqlite",
    ...(pg
      ? {
          databaseUrl: process.env.PDPP_TEST_POSTGRES_URL || "",
          testOnlyAlreadyAdmittedPostgresChildAttachment: attachment || "",
        }
      : {}),
    quiet: true,
    reconcilePolyfillManifests: false,
    semanticRetrievalBackend: backend,
  });
  try {
    await server.startupBackfillDone;
    assert.ok(failedCalls > 0, "real startup attempted embedding and failed");
    const tickets = await listDirtySearchIndexScopes(25);
    assert.ok(
      tickets.some((t) => t.connectorInstanceId === "cin_startup_retry" && t.stream === "items"),
      "startup failure must create durable retry ticket"
    );
    healthy = true;
    const round = await runSearchIndexDirtyReconcileRound();
    assert.equal(round.succeeded, 1);
    assert.equal((await listDirtySearchIndexScopes(25)).length, 0);
    const computed = await computeSemanticEntries({
      connectorId: manifest.connector_id,
      connectorInstanceId: "cin_startup_retry",
      data: { id: "k1", subject: "retained synthetic subject" },
      recordKey: "k1",
      stream: "items",
    });
    assert.ok(computed);
    const rows = pg
      ? (
          await postgresQuery(
            "SELECT record_key, scope_key, input_identity FROM semantic_search_blob WHERE connector_instance_id = $1",
            ["cin_startup_retry"]
          )
        ).rows
      : getDb()
          .prepare(
            "SELECT record_key, scope_key, input_identity FROM semantic_search_rowid WHERE connector_instance_id = ? UNION ALL SELECT record_key, scope_key, input_identity FROM semantic_search_blob WHERE connector_instance_id = ?"
          )
          .all("cin_startup_retry", "cin_startup_retry");
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [...computed.entries, ...computed.retained].map((e) => ({
        input_identity: e.inputIdentity,
        record_key: "k1",
        scope_key: e.scopeKey,
      }))
    );
  } finally {
    await closeTestServer(server);
    if (pg) {
      await clearRetainedPgState();
      await closePostgresStorage();
    } else {
      closeDb();
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("startup retry preserves history and parks, fences clears, respects pins and deleted state", async () => {
  const pg = Boolean(process.env.PDPP_TEST_POSTGRES_URL);
  if (pg) {
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: process.env.PDPP_TEST_POSTGRES_URL || "",
    });
  } else {
    initDb(":memory:");
  }
  const sql = async (query: string, args: unknown[] = []) => {
    if (pg) {
      let n = 0;
      return (
        await postgresQuery(
          query.replaceAll("?", () => {
            n += 1;
            return `$${n}`;
          }),
          args
        )
      ).rows;
    }
    const stmt = getDb().prepare(query);
    if (query.startsWith("SELECT")) {
      return stmt.all(...args);
    }
    stmt.run(...args);
    return [];
  };
  try {
    await registerConnector(manifest, { backfillRetrievalIndexes: false });
    for await (const instance of ["cin_retry_control", "cin_retry_other"]) {
      await ingestRecord(
        {
          connector_id: manifest.connector_id,
          connector_instance_id: instance,
        },
        {
          data: { id: "k1", subject: "synthetic control" },
          emitted_at: "2026-07-16T00:00:00.000Z",
          key: "k1",
          stream: "items",
        },
        { deferIndexes: true }
      );
    }
    const key = { connectorInstanceId: "cin_retry_control", stream: "items" };
    await sql(
      "UPDATE search_index_dirty SET attempts = 7, next_attempt_at = ?, marked_at = ? WHERE connector_instance_id = ?",
      ["2099-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", key.connectorInstanceId]
    );
    const read = async () =>
      required(
        (await sql("SELECT * FROM search_index_dirty WHERE connector_instance_id = ?", [key.connectorInstanceId]))[0]
      );
    const otherBefore = await sql("SELECT * FROM search_index_dirty WHERE connector_instance_id = ?", [
      "cin_retry_other",
    ]);
    const before = await read();
    const generation = currentStorageGeneration();
    await queueStartupSearchIndexRetry(
      {
        ...manifest,
        storage_binding: { connector_instance_id: key.connectorInstanceId },
      } as never,
      generation
    );
    const after = await read();
    assert.equal(Number(after.revision), Number(before.revision) + 1);
    for (const field of ["attempts", "next_attempt_at", "marked_at", "operator_parked"]) {
      assert.equal(after[field], before[field]);
    }
    assert.deepEqual(
      await sql("SELECT * FROM search_index_dirty WHERE connector_instance_id = ?", ["cin_retry_other"]),
      otherBefore
    );
    assert.equal(await clearSearchIndexDirty(key, Number(before.revision), new Date().toISOString()), false);
    await sql("UPDATE search_index_dirty SET operator_parked = 1 WHERE connector_instance_id = ?", [
      key.connectorInstanceId,
    ]);
    await queueStartupSearchIndexRetry(
      { ...manifest, connector_instance_id: key.connectorInstanceId } as never,
      generation
    );
    assert.equal(Number((await read()).operator_parked), 1);
    assert.equal(Number((await read()).attempts), 7);
    await sql("UPDATE search_index_dirty SET dirty = 0, operator_parked = 0 WHERE connector_instance_id = ?", [
      key.connectorInstanceId,
    ]);
    await queueStartupSearchIndexRetry(
      { ...manifest, connector_instance_id: key.connectorInstanceId } as never,
      generation
    );
    assert.equal(Number((await read()).dirty), 1);
    assert.equal(Number((await read()).attempts), 0);
    assert.equal((await read()).next_attempt_at, null);
    await sql("DELETE FROM records WHERE connector_instance_id = ?", [key.connectorInstanceId]);
    await sql("DELETE FROM search_index_dirty WHERE connector_instance_id = ?", [key.connectorInstanceId]);
    await markStartupSearchIndexFailure({
      connectorId: manifest.connector_id,
      connectorInstanceId: key.connectorInstanceId,
      generation,
    });
    assert.equal(
      (await sql("SELECT * FROM search_index_dirty WHERE connector_instance_id = ?", [key.connectorInstanceId])).length,
      0,
      "deleted scope must not resurrect"
    );
    // Deletion commits its tombstone before asynchronous projection teardown.
    // Another PostgreSQL process can acquire the transaction fence in between.
    await sql(
      "INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, updated_at) VALUES (?, ?, ?, ?, ?)",
      [manifest.connector_id, key.connectorInstanceId, key.stream, "residual-projection", "2026-11-03T00:00:00.000Z"]
    );
    await markStartupSearchIndexFailure({
      connectorId: manifest.connector_id,
      connectorInstanceId: key.connectorInstanceId,
      generation,
    });
    assert.equal(
      (await sql("SELECT * FROM search_index_dirty WHERE connector_instance_id = ?", [key.connectorInstanceId])).length,
      1,
      "legacy instance-less index state still needs a retry when not deleted"
    );
    await sql("DELETE FROM search_index_dirty WHERE connector_instance_id = ?", [key.connectorInstanceId]);
    await sql(
      "INSERT INTO connector_instance_tombstones(connector_instance_id, owner_subject_id, connector_id, source_kind, source_binding_key, deleted_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        key.connectorInstanceId,
        "synthetic-owner",
        manifest.connector_id,
        "synthetic",
        "deleted",
        "2026-11-03T00:00:00.000Z",
      ]
    );
    await markStartupSearchIndexFailure({
      connectorId: manifest.connector_id,
      connectorInstanceId: key.connectorInstanceId,
      generation,
    });
    assert.equal(
      (await sql("SELECT * FROM search_index_dirty WHERE connector_instance_id = ?", [key.connectorInstanceId])).length,
      0,
      "deleted connection must not regain a retry ticket from residual index state"
    );
    let unlock: () => void = () => {
      /* assigned synchronously below */
    };
    let entered: () => void = () => {
      /* assigned synchronously below */
    };
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const fence = withConnectorInstanceControlPlaneWrite("cin_retry_other", async () => {
      entered();
      await release;
    });
    await held;
    const delayed = markStartupSearchIndexFailure({
      connectorId: manifest.connector_id,
      connectorInstanceId: "cin_retry_other",
      generation,
    });
    bumpStorageGeneration();
    unlock();
    await fence;
    await assert.rejects(delayed, STALE_GENERATION);
    await assert.rejects(queueStartupSearchIndexRetry(manifest as never, generation), STALE_GENERATION);
    assert.deepEqual(
      await sql("SELECT * FROM search_index_dirty WHERE connector_instance_id = ?", ["cin_retry_other"]),
      otherBefore
    );
  } finally {
    if (pg) {
      for (const table of ["records", "lexical_search_meta", "search_index_dirty", "connector_instance_tombstones"]) {
        // biome-ignore lint/performance/noAwaitInLoops: Cleanup is sequential and order-independent.
        await postgresQuery(`DELETE FROM ${table}`);
      }
      await closePostgresStorage();
    } else {
      closeDb();
    }
  }
});

test("one instance that cannot be queued does not leave its siblings without a retry ticket", async () => {
  const pg = Boolean(process.env.PDPP_TEST_POSTGRES_URL);
  if (pg) {
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: process.env.PDPP_TEST_POSTGRES_URL || "",
    });
  } else {
    initDb(":memory:");
  }
  const poisoned = "cin_a_poisoned";
  const healthy = "cin_b_healthy";
  try {
    await registerConnector(manifest, { backfillRetrievalIndexes: false });
    for await (const instance of [poisoned, healthy]) {
      await ingestRecord(
        {
          connector_id: manifest.connector_id,
          connector_instance_id: instance,
        },
        {
          data: { id: "k1", subject: "synthetic sibling" },
          emitted_at: "2026-07-16T00:00:00.000Z",
          key: "k1",
          stream: "items",
        },
        { deferIndexes: true }
      );
    }
    if (pg) {
      await postgresQuery("DELETE FROM search_index_dirty");
      await postgresQuery(
        "CREATE OR REPLACE FUNCTION startup_retry_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'poisoned instance'; END $$"
      );
      await postgresQuery(
        `CREATE TRIGGER startup_retry_test_reject BEFORE INSERT OR UPDATE ON search_index_dirty FOR EACH ROW WHEN (NEW.connector_instance_id = '${poisoned}') EXECUTE FUNCTION startup_retry_test_reject()`
      );
    } else {
      getDb().prepare("DELETE FROM search_index_dirty").run();
      getDb().exec(
        `CREATE TRIGGER startup_retry_test_reject BEFORE INSERT ON search_index_dirty WHEN NEW.connector_instance_id = '${poisoned}' BEGIN SELECT RAISE(ABORT, 'poisoned instance'); END`
      );
    }
    await assert.rejects(
      queueStartupSearchIndexRetry(manifest as never, currentStorageGeneration()),
      (error) => error instanceof AggregateError && error.errors.length === 1
    );
    assert.deepEqual(
      (await listDirtySearchIndexScopes(25))
        .map((scope) => scope.connectorInstanceId)
        .filter((id) => id === poisoned || id === healthy),
      [healthy]
    );
  } finally {
    if (pg) {
      await postgresQuery("DROP TRIGGER IF EXISTS startup_retry_test_reject ON search_index_dirty");
      await postgresQuery("DROP FUNCTION IF EXISTS startup_retry_test_reject()");
      await postgresQuery("DELETE FROM records");
      await postgresQuery("DELETE FROM search_index_dirty");
      await closePostgresStorage();
    } else {
      closeDb();
    }
  }
});

const FAULT = "startup_retry_test_fault";

/**
 * Restart over one retained record and no tickets, then let the real startup
 * backfill run. `fault` makes the first ticket write fail on either backend.
 * SQLite cannot keep a counter across a rolled-back statement, so there the
 * fault trigger is dropped when the server logs the failed queue write.
 */
async function startOverRetainedRecord({
  backend,
  fault = false,
  semanticRetrievalSupported,
  source = manifest,
}: {
  backend: unknown;
  fault?: boolean;
  semanticRetrievalSupported?: boolean;
  source?: typeof manifest;
}) {
  const dir = mkdtempSync(join(tmpdir(), "startup-retry-"));
  const dbPath = join(dir, "db.sqlite");
  const pg = Boolean(process.env.PDPP_TEST_POSTGRES_URL);
  if (pg) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: process.env.PDPP_TEST_POSTGRES_URL || "" });
  } else {
    initDb(dbPath);
  }
  const attachment = pg
    ? await createAlreadyAdmittedTestDatabaseChildAttachment(process.env.PDPP_TEST_POSTGRES_URL || "")
    : undefined;
  await registerConnector(source, { backfillRetrievalIndexes: false });
  await ingestRecord(
    { connector_id: source.connector_id, connector_instance_id: "cin_startup_retry" },
    {
      data: { id: "k1", subject: "retained synthetic subject" },
      emitted_at: "2026-07-16T00:00:00.000Z",
      key: "k1",
      stream: "items",
    },
    { deferIndexes: true }
  );
  if (pg) {
    await postgresQuery("DELETE FROM search_index_dirty");
    if (fault) {
      await postgresQuery(`CREATE SEQUENCE IF NOT EXISTS ${FAULT}_seq`);
      await postgresQuery(`SELECT setval('${FAULT}_seq', 1, false)`);
      await postgresQuery(
        `CREATE OR REPLACE FUNCTION ${FAULT}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('${FAULT}_seq') = 1 THEN RAISE EXCEPTION 'transient fault'; END IF; RETURN NEW; END $$`
      );
      await postgresQuery(
        `CREATE TRIGGER ${FAULT} BEFORE INSERT OR UPDATE ON search_index_dirty FOR EACH ROW EXECUTE FUNCTION ${FAULT}()`
      );
    }
  } else {
    getDb().prepare("DELETE FROM search_index_dirty").run();
    if (fault) {
      getDb().exec(
        `CREATE TRIGGER ${FAULT} BEFORE INSERT ON search_index_dirty BEGIN SELECT RAISE(ABORT, 'transient fault'); END`
      );
    }
    closeDb();
  }
  const warnings: string[] = [];
  const logger = pino(
    { level: "warn" },
    {
      write(line: string) {
        const message = String(JSON.parse(line).msg);
        warnings.push(message);
        if (!pg && fault && message.includes("retry queue write failed")) {
          getDb().exec(`DROP TRIGGER IF EXISTS ${FAULT}`);
        }
      },
    }
  );
  const server = await startServer({
    asPort: 0,
    dbPath,
    logger,
    rsPort: 0,
    storageBackend: pg ? "postgres" : "sqlite",
    ...(pg
      ? {
          databaseUrl: process.env.PDPP_TEST_POSTGRES_URL || "",
          testOnlyAlreadyAdmittedPostgresChildAttachment: attachment || "",
        }
      : {}),
    quiet: true,
    reconcilePolyfillManifests: false,
    ...(semanticRetrievalSupported === undefined ? {} : { semanticRetrievalSupported }),
    semanticRetrievalBackend: backend,
  });
  return {
    server,
    warnings,
    async finish() {
      await closeTestServer(server);
      if (pg) {
        await postgresQuery(`DROP TRIGGER IF EXISTS ${FAULT} ON search_index_dirty`);
        await postgresQuery(`DROP FUNCTION IF EXISTS ${FAULT}()`);
        await postgresQuery(`DROP SEQUENCE IF EXISTS ${FAULT}_seq`);
        await clearRetainedPgState();
        await closePostgresStorage();
      } else {
        closeDb();
      }
      rmSync(dir, { force: true, recursive: true });
    },
  };
}

function failingEmbeddingBackend() {
  const stub = makeStubBackend();
  return {
    ...stub,
    embedDocument: async () => {
      throw new LocalTransformerExecutorError("transformer_deadline");
    },
  };
}

async function retainedTickets(connectorId: string = manifest.connector_id) {
  return await listDirtySearchIndexScopes(25, { connectorId });
}

test("a failed ticket write at startup is retried once so the failed backfill is not left without a ticket", async () => {
  const run = await startOverRetainedRecord({ backend: failingEmbeddingBackend(), fault: true });
  try {
    await run.server.startupBackfillDone;
    assert.equal(
      run.warnings.filter((m) => m.includes("retry queue write failed")).length,
      1,
      `the first ticket write failed once: ${JSON.stringify(run.warnings)}`
    );
    assert.equal((await retainedTickets()).length, 1, "the retry after the loop wrote the ticket");
  } finally {
    await run.finish();
  }
});

test("a semantic backend that is configured but unavailable at startup queues a ticket", async () => {
  const run = await startOverRetainedRecord({ backend: { ...makeStubBackend(), available: () => false } });
  try {
    await run.server.startupBackfillDone;
    assert.equal((await retainedTickets()).length, 1);
  } finally {
    await run.finish();
  }
});

test("no ticket is queued when no semantic backend is configured or the connector declares no semantic fields", async () => {
  const unconfigured = await startOverRetainedRecord({ backend: undefined, semanticRetrievalSupported: false });
  try {
    await unconfigured.server.startupBackfillDone;
    assert.equal((await retainedTickets()).length, 0, "no backend configured");
  } finally {
    await unconfigured.finish();
  }
  const lexicalOnly = {
    ...manifest,
    connector_id: "startup-retry-lexical-only",
    manifest_uri: "https://example.test/startup-retry-lexical-only",
    streams: manifest.streams.map(({ query: _query, ...stream }) => ({ ...stream, query: { search: {} } })),
  };
  const noFields = await startOverRetainedRecord({
    backend: { ...makeStubBackend(), available: () => false },
    source: lexicalOnly as never,
  });
  try {
    await noFields.server.startupBackfillDone;
    assert.equal((await retainedTickets(lexicalOnly.connector_id)).length, 0, "no semantic_fields declared");
  } finally {
    await noFields.finish();
  }
});
