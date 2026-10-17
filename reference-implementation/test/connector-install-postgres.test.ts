// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector install on Postgres over a connector that already has data.
 *
 * Incident (v0.7.62, 2026-10-17): installing gmail over an instance migrated
 * with its connections and records activated the connector, but the request
 * never returned. The install held the file lock and an idle-in-transaction
 * lifecycle advisory lock while `registerConnector` re-derived every existing
 * record, one transaction per record. Every later install failed as busy.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { acquireDirectoryLock } from "../server/connector-install/directory-lock.ts";
import { ConnectorInstallTimeoutError } from "../server/connector-install/index.ts";
import { connectorInstanceAdvisoryLockKey } from "../server/connector-instance-write-coordinator.ts";
import { withConnectorLifecycleLock } from "../server/connector-lifecycle-lock.ts";
import { postgresRepairRecordDerivedColumnsPage, recordDerivedColumnsStream } from "../server/postgres-records.ts";
import { closeDb, initDb } from "../server/db.ts";
import { __setRecordDerivedRepairHookForTest, runRecordDerivedRepairRound } from "../server/record-derived-repair.ts";
import { markRecordDerivedRepairPendingPostgres } from "../server/stores/record-derived-repair-store.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { runSearchIndexDirtyReconcileRound } from "../server/search-index-reconcile.ts";
import { configureSemanticBackend, makeStubBackend } from "../server/search-semantic.ts";
import {
  GMAIL_CONNECTOR_ID as CONNECTOR_ID,
  GMAIL_INSTALL_DIGEST as digest,
  GMAIL_INSTALL_VERSION,
  gmailInstallService,
  installedGmail,
  seedMigratedGmail as seedGmail,
} from "./helpers/connector-install-gmail-fixture.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset";
const INSTANCES = ["cin_gmail_primary", "cin_gmail_work"] as const;
const RECORDS_PER_STREAM = 40;
// `withConnectorLifecycleLock` key for gmail, as two 32-bit halves in pg_locks.
const GMAIL_LIFECYCLE_LOCK = { classid: 1_636_929_005, objid: 1_056_513_344 };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The stub embedding backend, counting the documents it embeds. */
const embedder = (() => {
  const stub = makeStubBackend({ dimensions: 16 });
  const counter = { documents: 0 };
  return {
    backend: {
      ...stub,
      embedDocument: (text: string) => {
        counter.documents += 1;
        return stub.embedDocument(text);
      },
    },
    counter,
  };
})();

async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${String(ms)} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withPostgres(name: string, body: (databaseUrl: string) => Promise<void>): Promise<void> {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_install_${name}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      configureSemanticBackend(embedder.backend);
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await body(databaseUrl);
      } finally {
        configureSemanticBackend(null);
        await closePostgresStorage();
        closeDb();
      }
    }
  );
}

/** True when nothing holds the install fence: probe it by taking and dropping it. */
function installFenceIsFree(dataDir: string): boolean {
  try {
    acquireDirectoryLock(dataDir, ".connector-install.lock", "busy").release();
    return true;
  } catch {
    return false;
  }
}

/** Requests for the advisory lock `key` (a signed bigint) that wait for another session. */
async function advisoryLockWaiters(key: string): Promise<number> {
  const unsigned = BigInt.asUintN(64, BigInt(key));
  const result = await postgresQuery<{ waiters: string }>(
    `SELECT count(*)::text AS waiters FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
        AND classid = $1::bigint::oid AND objid = $2::bigint::oid
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [(unsigned >> 32n).toString(), (unsigned & 0xff_ff_ff_ffn).toString()]
  );
  return Number(result.rows[0]?.waiters ?? 0);
}

async function waitForAdvisoryLockWaiter(key: string, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await advisoryLockWaiters(key)) === 0) {
    assert.ok(Date.now() < deadline, `${what} never waited for the lock`);
    await new Promise((settle) => setTimeout(settle, 10));
  }
}

async function gmailLifecycleLockHolders(): Promise<number> {
  const result = await postgresQuery<{ holders: string }>(
    `SELECT count(*)::text AS holders FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND classid = $1 AND objid = $2 AND objsubid = 1`,
    [GMAIL_LIFECYCLE_LOCK.classid, GMAIL_LIFECYCLE_LOCK.objid]
  );
  return Number(result.rows[0]?.holders ?? 0);
}

test(
  "PostgreSQL: installing over a connector with existing records returns before the O(records) repair and holds no lock during it",
  { skip: POSTGRES_SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"));
    const repairEntered = deferred();
    const repairRelease = deferred();
    let repair: Promise<unknown> | undefined;
    try {
      await withPostgres("repair", async () => {
        await seedGmail({ instances: INSTANCES, recordsPerStream: RECORDS_PER_STREAM });
        __setRecordDerivedRepairHookForTest(async (point) => {
          if (point === "after-page") {
            repairEntered.resolve();
            await repairRelease.promise;
          }
        });
        try {
          const service = gmailInstallService(dataDir, {
            onRepair: (started) => {
              repair = started;
            },
          });
          const installed = await within(service.install(CONNECTOR_ID, digest), 5000, "gmail install");
          assert.equal(installed.digest, digest);
          await within(repairEntered.promise, 5000, "derived repair start");

          // The repair is running, and neither lock is held.
          assert.equal(installFenceIsFree(dataDir), true);
          assert.equal(await gmailLifecycleLockHolders(), 0);
          assert.equal(
            await within(
              withConnectorLifecycleLock(dataDir, CONNECTOR_ID, async () => "free"),
              2000,
              "lifecycle lock"
            ),
            "free"
          );

          repairRelease.resolve();
          await within(Promise.resolve(repair), 10_000, "derived repair");
          const stale = await postgresQuery<{ stale: string }>(
            `SELECT count(*)::text AS stale FROM records
              WHERE connector_id = $1 AND stream = 'messages' AND cursor_value IS DISTINCT FROM record_json->>'received_at'`,
            [CONNECTOR_ID]
          );
          assert.equal(stale.rows[0]?.stale, "0", "the deferred repair still re-derives existing records");
        } finally {
          repairRelease.resolve();
          await Promise.resolve(repair).catch(() => undefined);
          __setRecordDerivedRepairHookForTest(null);
        }
      });
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
  }
);

test(
  "PostgreSQL: same-process lifecycle waiters cannot exhaust the pool the install holder needs",
  { skip: POSTGRES_SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"));
    const stage = deferred();
    const waiters: Promise<unknown>[] = [];
    let repair: Promise<unknown> | undefined;
    try {
      await withPostgres("pool", async () => {
        await seedGmail({ instances: INSTANCES, recordsPerStream: RECORDS_PER_STREAM });
        const service = gmailInstallService(dataDir, {
          onRepair: (started) => {
            repair = started;
          },
          stage: stage.promise,
        });
        const installing = service.install(CONNECTOR_ID, digest);
        // The install now holds the gmail lifecycle lock and waits on its artifact.
        for (let attempt = 0; attempt < 200 && (await gmailLifecycleLockHolders()) === 0; attempt += 1) {
          await new Promise((settle) => setTimeout(settle, 10));
        }
        assert.equal(await gmailLifecycleLockHolders(), 1);
        // More waiters than the interactive pool has connections (8): scheduler
        // ticks, run starts and connection upserts for the same connector.
        for (let index = 0; index < 8; index += 1) {
          waiters.push(withConnectorLifecycleLock(dataDir, CONNECTOR_ID, async () => index));
        }
        await new Promise((settle) => setTimeout(settle, 200));
        stage.resolve();
        assert.equal((await within(installing, 5000, "gmail install")).digest, digest);
        assert.deepEqual(await within(Promise.all(waiters), 5000, "lifecycle waiters"), [0, 1, 2, 3, 4, 5, 6, 7]);
        await within(Promise.resolve(repair), 30_000, "derived repair");
      });
    } finally {
      stage.resolve();
      rmSync(dataDir, { force: true, recursive: true });
    }
  }
);

test(
  "PostgreSQL: terminating the backend of an open transaction fails that transaction without crashing the process",
  { skip: POSTGRES_SKIP },
  async () => {
    await withPostgres("terminate", async () => {
      const holding = deferred();
      const terminated = deferred();
      let holdingPid = 0;
      const transaction = withPostgresTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(424242)");
        const backend = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        holdingPid = backend.rows[0]?.pid ?? 0;
        holding.resolve();
        // Idle in transaction, as the install's lifecycle lock was.
        await terminated.promise;
        await client.query("SELECT 1");
      });
      await holding.promise;
      await postgresQuery("SELECT pg_terminate_backend($1)", [holdingPid]);
      await new Promise((settle) => setTimeout(settle, 200));
      terminated.resolve();
      // Before the fix, the client's unhandled `error` event crashed the process here.
      await assert.rejects(transaction);
      assert.equal((await postgresQuery<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok, 1);
    });
  }
);

// ---------------------------------------------------------------------------
// A large semantic backfill on a database where HNSW inserts are slow.
//
// Prod (2026-10-17): chatgpt installs over 289k records failed 3 of 3 times.
// A 500-row INSERT into semantic_search_blob passed the 15 s bulk
// statement_timeout, and the error rolled the install back. The trigger below
// stands in for an HNSW index that does not fit in memory: each row in one
// statement costs more than the one before, so a 500-row statement takes about
// 20 s and a 30-row statement well under 0.1 s.
// ---------------------------------------------------------------------------

const LARGE_RECORDS_PER_STREAM = 300;
/** messages declares 2 semantic fields and message_bodies 1. */
const LARGE_EXPECTED_VECTORS = LARGE_RECORDS_PER_STREAM * 3;
const SMALL_STATEMENT_TIMEOUT_MS = "1000";

async function slowSemanticInserts(): Promise<void> {
  await postgresQuery(`
    CREATE TABLE test_semantic_chunks (txid BIGINT PRIMARY KEY, rows_in_statement INTEGER NOT NULL);
    CREATE FUNCTION test_slow_semantic_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE position INTEGER;
    BEGIN
      INSERT INTO test_semantic_chunks VALUES (txid_current(), 1)
        ON CONFLICT (txid) DO UPDATE SET rows_in_statement = test_semantic_chunks.rows_in_statement + 1
        RETURNING rows_in_statement INTO position;
      PERFORM pg_sleep(0.00016 * position);
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_slow_semantic_insert BEFORE INSERT ON semantic_search_blob
      FOR EACH ROW EXECUTE FUNCTION test_slow_semantic_insert();
  `);
}

async function gmailVectorCount(): Promise<number> {
  const result = await postgresQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM semantic_search_blob WHERE connector_id = $1",
    [CONNECTOR_ID]
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function gmailDirtyScopes(): Promise<number> {
  const result = await postgresQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM search_index_dirty WHERE connector_id = $1 AND dirty <> 0",
    [CONNECTOR_ID]
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function withSmallBulkStatementTimeout(body: () => Promise<void>): Promise<void> {
  const previous = process.env.PDPP_POSTGRES_BULK_STATEMENT_TIMEOUT_MS;
  process.env.PDPP_POSTGRES_BULK_STATEMENT_TIMEOUT_MS = SMALL_STATEMENT_TIMEOUT_MS;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.PDPP_POSTGRES_BULK_STATEMENT_TIMEOUT_MS;
    else process.env.PDPP_POSTGRES_BULK_STATEMENT_TIMEOUT_MS = previous;
  }
}

test(
  "PostgreSQL: with slow vector inserts, an install returns at publication and the backfill completes in small chunks",
  { skip: POSTGRES_SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"));
    let repair: Promise<unknown> | undefined;
    try {
      await withSmallBulkStatementTimeout(() =>
        withPostgres("large", async () => {
          // The registry is already at the version being installed, with no
          // install record: what three failed chatgpt installs left on prod.
          await seedGmail({
            instances: ["cin_gmail_large"],
            recordsPerStream: LARGE_RECORDS_PER_STREAM,
            registered: installedGmail,
          });
          await slowSemanticInserts();
          const service = gmailInstallService(dataDir, {
            onRepair: (started) => {
              repair = started;
            },
          });

          const startedAt = Date.now();
          const installed = await within(service.install(CONNECTOR_ID, digest), 5000, "gmail install");
          assert.ok(Date.now() - startedAt < 5000);
          assert.equal(installed.manifest.version, GMAIL_INSTALL_VERSION);

          await within(Promise.resolve(repair), 120_000, "post-install repair");
          assert.equal(await gmailVectorCount(), LARGE_EXPECTED_VECTORS);
          assert.equal(await gmailDirtyScopes(), 0);
          const chunks = await postgresQuery<{ chunks: string; largest: number }>(
            "SELECT count(*)::text AS chunks, max(rows_in_statement) AS largest FROM test_semantic_chunks"
          );
          // Only committed chunks remain; every one stayed far below the fixed 500.
          assert.ok(Number(chunks.rows[0]?.chunks) > 1);
          assert.ok(Number(chunks.rows[0]?.largest) < 125, `largest chunk ${String(chunks.rows[0]?.largest)}`);
        })
      );
    } finally {
      await Promise.resolve(repair).catch(() => undefined);
      rmSync(dataDir, { force: true, recursive: true });
    }
  }
);

const CHILD_PROGRAM = `
  import { closeDb, initDb } from "./server/db.ts";
  import { initPostgresStorage } from "./server/postgres-storage.ts";
  import { configureSemanticBackend, makeStubBackend } from "./server/search-semantic.ts";
  import { GMAIL_CONNECTOR_ID, GMAIL_INSTALL_DIGEST, gmailInstallService } from "./test/helpers/connector-install-gmail-fixture.ts";
  initDb(":memory:");
  configureSemanticBackend(makeStubBackend({ dimensions: 16 }));
  await initPostgresStorage(
    { backend: "postgres", databaseUrl: process.env.PDPP_INSTALL_CHILD_DATABASE_URL },
    { testOnlyAlreadyAdmittedChildAttachment: process.env.PDPP_INSTALL_CHILD_ATTACHMENT }
  );
  const service = gmailInstallService(process.env.PDPP_INSTALL_CHILD_DATA_DIR);
  const startedAt = Date.now();
  await service.install(GMAIL_CONNECTOR_ID, GMAIL_INSTALL_DIGEST);
  console.log("INSTALLED " + String(Date.now() - startedAt));
  // Stay alive: the post-install repair runs until the parent kills us.
  setInterval(() => undefined, 1000);
`;

test(
  "PostgreSQL: a server killed mid-backfill resumes it after restart without re-embedding committed vectors",
  { skip: POSTGRES_SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"));
    try {
      await withSmallBulkStatementTimeout(() =>
        withPostgres("restart", async (databaseUrl) => {
          // Minted before any data exists: the guard admits a child only then.
          const attachment = await createAlreadyAdmittedTestDatabaseChildAttachment(databaseUrl);
          await seedGmail({ instances: ["cin_gmail_restart"], recordsPerStream: LARGE_RECORDS_PER_STREAM });
          await slowSemanticInserts();
          const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", CHILD_PROGRAM], {
            cwd: resolve(import.meta.dirname, ".."),
            env: {
              ...process.env,
              PDPP_INSTALL_CHILD_ATTACHMENT: attachment,
              PDPP_INSTALL_CHILD_DATABASE_URL: databaseUrl,
              PDPP_INSTALL_CHILD_DATA_DIR: dataDir,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          const exited = new Promise<void>((settle) => child.once("close", () => settle()));
          try {
            // Kill the server once the backfill has committed some vectors.
            const deadline = Date.now() + 60_000;
            while ((await gmailVectorCount()) < 100) {
              assert.ok(Date.now() < deadline, `backfill never started; child stderr: ${stderr.slice(-2000)}`);
              assert.equal(child.exitCode, null, `child exited early: ${stderr.slice(-2000)}`);
              await new Promise((settle) => setTimeout(settle, 50));
            }
          } finally {
            child.kill("SIGKILL");
            await exited;
          }
          assert.match(stdout, /INSTALLED \d+/, "the install returned before the backfill finished");
          const committedAtKill = await gmailVectorCount();
          assert.ok(committedAtKill < LARGE_EXPECTED_VECTORS, "the kill landed mid-backfill");
          assert.ok((await gmailDirtyScopes()) > 0, "the unfinished repair is durable");

          // After the restart, the maintenance sweep resumes the dirty scopes.
          embedder.counter.documents = 0;
          for (let round = 0; round < 20 && (await gmailDirtyScopes()) > 0; round += 1) {
            await runSearchIndexDirtyReconcileRound({ maxDurationMs: 60_000, pageSize: 25 });
          }
          assert.equal(await gmailDirtyScopes(), 0);
          assert.equal(await gmailVectorCount(), LARGE_EXPECTED_VECTORS);
          // Committed vectors are kept, not embedded again. At most the one
          // page in flight at the kill (500 record/field pairs) repeats.
          const remaining = LARGE_EXPECTED_VECTORS - committedAtKill;
          assert.ok(
            embedder.counter.documents <= remaining + 500 && embedder.counter.documents < LARGE_EXPECTED_VECTORS,
            `embedded ${String(embedder.counter.documents)} for ${String(remaining)} missing vectors`
          );
        })
      );
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Review round 3: removed search declarations, and durable column repair.
// ---------------------------------------------------------------------------

/** Index rows for the two streams the update makes unsearchable (the only streams with records). */
async function gmailIndexRows(): Promise<{
  lexical: number;
  lexicalMeta: number;
  semantic: number;
  semanticMeta: number;
}> {
  const count = async (sql: string) =>
    Number((await postgresQuery<{ n: string }>(sql, [CONNECTOR_ID, ["messages", "message_bodies"]])).rows[0]?.n ?? 0);
  return {
    lexical: await count(
      "SELECT count(*)::text AS n FROM lexical_search_index WHERE connector_id = $1 AND stream = ANY($2::text[])"
    ),
    lexicalMeta: await count(
      "SELECT count(*)::text AS n FROM lexical_search_meta WHERE connector_id = $1 AND stream = ANY($2::text[])"
    ),
    // semantic_search_blob has no stream column, and the records live only in these two streams.
    semantic: await count(
      "SELECT count(*)::text AS n FROM semantic_search_blob WHERE connector_id = $1 AND cardinality($2::text[]) > 0"
    ),
    semanticMeta: await count(
      "SELECT count(*)::text AS n FROM semantic_search_meta WHERE connector_id = $1 AND stream = ANY($2::text[])"
    ),
  };
}

/** gmail with the last search declarations removed from `messages` and `message_bodies`. */
const unsearchableGmail = {
  ...installedGmail,
  streams: ((installedGmail as Record<string, unknown>).streams as Record<string, unknown>[]).map((stream) => {
    if (stream.name !== "messages" && stream.name !== "message_bodies") return stream;
    const { query: _query, ...rest } = stream;
    return rest;
  }),
  version: "9.1.0",
};

test(
  "PostgreSQL: an update that removes the last search declarations leaves no stale index rows after reconcile",
  { skip: POSTGRES_SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"));
    try {
      await withPostgres("removed", async () => {
        await seedGmail({ instances: ["cin_gmail_removed"], recordsPerStream: 30 });
        let repair: Promise<unknown> | undefined;
        const capture = { onRepair: (started: Promise<unknown>) => (repair = started) };
        await gmailInstallService(dataDir, capture).install(CONNECTOR_ID, digest);
        await within(Promise.resolve(repair), 60_000, "first repair");
        const indexed = await gmailIndexRows();
        assert.ok(indexed.lexical > 0 && indexed.semantic > 0, JSON.stringify(indexed));

        const nextDigest = `sha256:${"c".repeat(64)}`;
        await gmailInstallService(dataDir, capture, { digest: nextDigest, manifest: unsearchableGmail }).install(
          CONNECTOR_ID,
          nextDigest
        );
        await within(Promise.resolve(repair), 60_000, "update repair");
        assert.deepEqual(await gmailIndexRows(), { lexical: 0, lexicalMeta: 0, semantic: 0, semanticMeta: 0 });
        assert.equal(await gmailDirtyScopes(), 0);
      });
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
  }
);

test(
  "PostgreSQL: an interrupted column repair stays queued with its cursor and a later sweep round completes it",
  { skip: POSTGRES_SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"));
    let repair: Promise<unknown> | undefined;
    try {
      await withPostgres("columns", async () => {
        // 700 records: three 256-record pages per stream.
        await seedGmail({ instances: ["cin_gmail_columns"], recordsPerStream: 700 });
        const staleCursors = async () =>
          Number(
            (
              await postgresQuery<{ n: string }>(
                `SELECT count(*)::text AS n FROM records
                  WHERE connector_id = $1 AND stream = 'messages' AND cursor_value IS DISTINCT FROM record_json->>'received_at'`,
                [CONNECTOR_ID]
              )
            ).rows[0]?.n ?? 0
          );
        assert.equal(await staleCursors(), 700);
        let pages = 0;
        __setRecordDerivedRepairHookForTest((point, scope) => {
          if (point === "after-page" && scope.stream === "messages" && ++pages === 2) {
            throw new Error("simulated crash after two committed pages");
          }
        });
        try {
          await gmailInstallService(dataDir, { onRepair: (started) => (repair = started) }).install(
            CONNECTOR_ID,
            digest
          );
          await assert.rejects(Promise.resolve(repair), /Record column repair failed/);
        } finally {
          __setRecordDerivedRepairHookForTest(null);
        }
        const pending = await postgresQuery<{ after_record_key: string | null; attempts: number; last_error: string }>(
          "SELECT after_record_key, attempts, last_error FROM record_derived_repair_pending WHERE connector_id = $1 AND stream = 'messages'",
          [CONNECTOR_ID]
        );
        assert.equal(pending.rows.length, 1);
        assert.equal(pending.rows[0]?.after_record_key, "messages-000511", "the cursor is the last committed record");
        assert.equal(pending.rows[0]?.attempts, 1);
        assert.equal(await staleCursors(), 700 - 512, "two pages are repaired, the rest are not");

        // The next eligible sweep round (past the failure backoff) resumes from the cursor.
        const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        const round = await runRecordDerivedRepairRound({ maxDurationMs: 60_000, nowIso: later });
        assert.equal(round.failed, 0);
        assert.equal(await staleCursors(), 0);
        const left = await postgresQuery<{ n: string }>(
          "SELECT count(*)::text AS n FROM record_derived_repair_pending WHERE connector_id = $1",
          [CONNECTOR_ID]
        );
        assert.equal(left.rows[0]?.n, "0");
      });
    } finally {
      await Promise.resolve(repair).catch(() => undefined);
      rmSync(dataDir, { force: true, recursive: true });
    }
  }
);

test(
  "PostgreSQL: a column-repair round that snapshotted an older job never resumes a requeued job from the old cursor",
  { skip: POSTGRES_SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"));
    let repair: Promise<unknown> | undefined;
    try {
      await withPostgres("requeue", async () => {
        await seedGmail({ instances: ["cin_gmail_requeue"], recordsPerStream: 700 });
        const staleCursors = async () =>
          Number(
            (
              await postgresQuery<{ n: string }>(
                `SELECT count(*)::text AS n FROM records
                  WHERE connector_id = $1 AND stream = 'messages' AND cursor_value IS DISTINCT FROM record_json->>'received_at'`,
                [CONNECTOR_ID]
              )
            ).rows[0]?.n ?? 0
          );
        // Job 1 stops after two pages, so its row holds cursor messages-000511.
        let pages = 0;
        __setRecordDerivedRepairHookForTest((point, scope) => {
          if (point === "after-page" && scope.stream === "messages" && ++pages === 2) {
            throw new Error("simulated crash after two committed pages");
          }
        });
        try {
          await gmailInstallService(dataDir, { onRepair: (started) => (repair = started) }).install(
            CONNECTOR_ID,
            digest
          );
          await assert.rejects(Promise.resolve(repair));
        } finally {
          __setRecordDerivedRepairHookForTest(null);
        }
        const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

        // Round A snapshots job 1 and pauses before it takes the stream.
        const paused = deferred();
        const resume = deferred();
        __setRecordDerivedRepairHookForTest(async (point, scope) => {
          if (point === "after-snapshot" && scope.stream === "messages") {
            __setRecordDerivedRepairHookForTest(null);
            paused.resolve();
            await resume.promise;
          }
        });
        const roundA = runRecordDerivedRepairRound({ connectorId: CONNECTOR_ID, nowIso: later });
        await paused.promise;

        // Round B finishes job 1. A reinstall then queues job 2 for the same
        // stream from the start, over records whose columns are stale again.
        await runRecordDerivedRepairRound({ connectorId: CONNECTOR_ID, nowIso: later });
        await postgresQuery("UPDATE records SET cursor_value = NULL WHERE connector_id = $1 AND stream = 'messages'", [
          CONNECTOR_ID,
        ]);
        await withPostgresTransaction((client) =>
          markRecordDerivedRepairPendingPostgres(
            client,
            { connectorId: CONNECTOR_ID, connectorInstanceId: "cin_gmail_requeue", stream: "messages" },
            new Date().toISOString()
          )
        );

        resume.resolve();
        await roundA;
        // Whatever round A did, job 2 is either finished or still queued.
        await runRecordDerivedRepairRound({ connectorId: CONNECTOR_ID, nowIso: later });
        assert.equal(await staleCursors(), 0, "no record before the old cursor was skipped");
      });
    } finally {
      __setRecordDerivedRepairHookForTest(null);
      await Promise.resolve(repair).catch(() => undefined);
      rmSync(dataDir, { force: true, recursive: true });
    }
  }
);

test(
  "PostgreSQL: a column repair that waits for the instance lock derives from the payload committed meanwhile",
  { skip: POSTGRES_SKIP },
  async () => {
    await withPostgres("repairrace", async () => {
      const instance = "cin_gmail_race";
      const recordKey = "messages-000001";
      const newerReceivedAt = "2027-06-01T00:00:00.000Z";
      await seedGmail({ instances: [instance], recordsPerStream: 3, registered: installedGmail });
      await withPostgresTransaction((client) =>
        markRecordDerivedRepairPendingPostgres(
          client,
          { connectorId: CONNECTOR_ID, connectorInstanceId: instance, stream: "messages" },
          new Date().toISOString()
        )
      );
      const lockHeld = deferred();
      const repairWaits = deferred();
      // Session B: an ingestion that commits a newer payload under the
      // instance lock, as every record write does. Its cursor, primary key and
      // semantic time all derive differently from the older payload's.
      const ingestion = withPostgresTransaction(
        async (client) => {
          lockHeld.resolve();
          await repairWaits.promise;
          await client.query(
            `UPDATE records
                SET record_json = jsonb_set(jsonb_set(record_json, '{received_at}', to_jsonb($3::text)),
                                            '{id}', to_jsonb('newer-id'::text)),
                    version = version + 1, cursor_value = $3
              WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2`,
            [instance, recordKey, newerReceivedAt]
          );
        },
        { lockConnectorInstanceId: instance }
      );
      try {
        await lockHeld.promise;
        // Session A: the repair reads its page, then waits for the lock B holds.
        const round = runRecordDerivedRepairRound({ connectorId: CONNECTOR_ID });
        await waitForAdvisoryLockWaiter(connectorInstanceAdvisoryLockKey(instance), "the column repair");
        repairWaits.resolve();
        await ingestion;
        const result = await within(round, 30_000, "column repair round");
        assert.equal(result.failed, 0);

        const row = await postgresQuery<{ cursor_value: string; received_at: string }>(
          `SELECT cursor_value, record_json->>'received_at' AS received_at FROM records
            WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2`,
          [instance, recordKey]
        );
        assert.equal(row.rows[0]?.received_at, newerReceivedAt);
        assert.equal(row.rows[0]?.cursor_value, newerReceivedAt, "the cursor derives from the stored payload");
        // Oracle for all three columns: a repair over the stored payload finds nothing to change.
        const messages = ((installedGmail as Record<string, unknown>).streams as Record<string, unknown>[]).find(
          (stream) => stream.name === "messages"
        );
        const rerun = await postgresRepairRecordDerivedColumnsPage({
          afterRecordKey: null,
          budget: { chunkSize: 256 },
          connectorId: CONNECTOR_ID,
          connectorInstanceId: instance,
          manifest: { ...installedGmail, streams: [messages] },
          manifestStream: recordDerivedColumnsStream(messages),
          stream: "messages",
        });
        assert.equal(rerun.updated, 0, "every derived column matches the stored payload");
      } finally {
        repairWaits.resolve();
        await ingestion.catch(() => undefined);
      }
    });
  }
);

test(
  "PostgreSQL: a deadline while an install waits for the lifecycle lock releases the install fence",
  { skip: POSTGRES_SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"));
    try {
      await withPostgres("lifecycledeadline", async () => {
        await seedGmail({ instances: ["cin_gmail_deadline"], recordsPerStream: 1 });
        const lifecycleLockId = createHash("sha256")
          .update(`connector-lifecycle:${CONNECTOR_ID}`)
          .digest()
          .readBigInt64BE(0)
          .toString();
        // The holder is this process (the waiter queues in memory) or another
        // session (the waiter waits on the advisory lock itself).
        const holders = {
          "another session": (done: Promise<void>, entered: () => void) =>
            withPostgresTransaction(async (client) => {
              await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lifecycleLockId]);
              entered();
              await done;
            }),
          "this process": (done: Promise<void>, entered: () => void) =>
            withConnectorLifecycleLock(dataDir, CONNECTOR_ID, async () => {
              entered();
              await done;
            }),
        };
        for (const [holderName, hold] of Object.entries(holders)) {
          const entered = deferred();
          const done = deferred();
          const holding = hold(done.promise, entered.resolve);
          try {
            await entered.promise;
            await assert.rejects(
              gmailInstallService(dataDir, { installTimeoutMs: 200 }).install(CONNECTOR_ID, digest),
              ConnectorInstallTimeoutError
            );
            const deadline = Date.now() + 2000;
            while (!installFenceIsFree(dataDir)) {
              assert.ok(Date.now() < deadline, `the install fence stayed held (holder: ${holderName})`);
              await new Promise((settle) => setTimeout(settle, 10));
            }
          } finally {
            done.resolve();
            await holding;
          }
        }
      });
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
  }
);

test(
  "PostgreSQL: removing semantic fields with no semantic backend keeps the cleanup scope dirty",
  { skip: POSTGRES_SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"));
    try {
      await withPostgres("nobackend", async () => {
        await seedGmail({ instances: ["cin_gmail_nobackend"], recordsPerStream: 30 });
        let repair: Promise<unknown> | undefined;
        const capture = { onRepair: (started: Promise<unknown>) => (repair = started) };
        await gmailInstallService(dataDir, capture).install(CONNECTOR_ID, digest);
        await within(Promise.resolve(repair), 60_000, "first repair");
        const before = await gmailIndexRows();
        assert.ok(before.semantic > 0 && before.semanticMeta > 0, JSON.stringify(before));

        // The server loses its semantic backend, then an update removes the fields.
        configureSemanticBackend(null);
        const nextDigest = `sha256:${"c".repeat(64)}`;
        await gmailInstallService(dataDir, capture, { digest: nextDigest, manifest: unsearchableGmail }).install(
          CONNECTOR_ID,
          nextDigest
        );
        await Promise.resolve(repair).catch(() => undefined);
        const debt = await postgresQuery<{ stream: string; last_error: string }>(
          `SELECT stream, last_error FROM search_index_dirty
            WHERE connector_id = $1 AND dirty <> 0 AND stream = ANY($2::text[]) ORDER BY stream`,
          [CONNECTOR_ID, ["messages", "message_bodies"]]
        );
        assert.deepEqual(
          debt.rows.map((row) => row.stream),
          ["message_bodies", "messages"],
          "the semantic cleanup debt stays dirty"
        );
        assert.match(String(debt.rows[0]?.last_error), /no semantic backend/);

        // With a backend again, the retried scopes remove the stale vectors.
        configureSemanticBackend(embedder.backend);
        await postgresQuery("UPDATE search_index_dirty SET next_attempt_at = NULL WHERE connector_id = $1", [
          CONNECTOR_ID,
        ]);
        await runSearchIndexDirtyReconcileRound({ maxDurationMs: 60_000, pageSize: 25 });
        assert.deepEqual(await gmailIndexRows(), { lexical: 0, lexicalMeta: 0, semantic: 0, semanticMeta: 0 });
      });
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
  }
);
