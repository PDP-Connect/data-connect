// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  getLastPostgresDerivedIndexMaintenanceReceipt,
  parsePostgresDerivedIndexMaintenanceWindow,
  runPostgresDerivedIndexMaintenance,
} from "../server/postgres-derived-index-maintenance.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

// Env gate: PDPP_TEST_POSTGRES_URL must be set, matching
// postgres-orphan-blob-reclaim.test.ts. No hardcoded fallback URL — one makes
// the case below dial a host that is absent under the memory-default profile
// (and in CI, which runs no PostgreSQL for that profile) and fail on
// ECONNREFUSED, which reads as a broken maintenance path rather than an
// unavailable database.
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
let databaseCounter = 0;

interface MaintenanceProcess {
  kill: () => Promise<void>;
  outcome: () => Promise<{ error?: string; status?: string }>;
}

function databaseName(): string {
  databaseCounter += 1;
  return `pdpp_derived_index_maintenance_${process.pid}_${databaseCounter}`;
}

test("derived-index maintenance defaults to a safe UTC off-peak window and accepts overrides", () => {
  assert.deepEqual(parsePostgresDerivedIndexMaintenanceWindow(""), { endMinute: 300, startMinute: 60 });
  assert.deepEqual(parsePostgresDerivedIndexMaintenanceWindow("01:30-04:00"), {
    endMinute: 240,
    startMinute: 90,
  });
  assert.equal(parsePostgresDerivedIndexMaintenanceWindow("disabled"), null);
  assert.throws(() => parsePostgresDerivedIndexMaintenanceWindow("overnight"), /HH:MM-HH:MM/);
});

if (POSTGRES_URL) {
  test("derived-index maintenance vacuums known heavy tables and concurrently reindexes present static search indexes", async () => {
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName: databaseName() },
      async (databaseUrl) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        try {
          await postgresQuery(
            `INSERT INTO lexical_search_index (connector_id, connector_instance_id, stream, record_key, field, value)
             SELECT 'connector', 'instance', 'stream', 'record-' || series::text, 'field', repeat('searchable value ', 32)
               FROM generate_series(1, 3000) AS series`
          );
          await postgresQuery("DELETE FROM lexical_search_index WHERE record_key <> 'record-1'");
          await postgresQuery("ANALYZE lexical_search_index");

          const before = await postgresQuery<{ index_oid: string; last_vacuum: string | null }>(
            `SELECT stats.last_vacuum::text AS last_vacuum,
                    index_class.oid::text AS index_oid
               FROM pg_stat_user_tables AS stats
               JOIN pg_class AS index_class ON index_class.relname = 'idx_pg_lexical_search_document'
               JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
              WHERE stats.schemaname = current_schema()
                AND stats.relname = 'lexical_search_index'
                AND index_namespace.nspname = current_schema()`
          );
          assert.equal(before.rowCount, 1);

          const receipt = await runPostgresDerivedIndexMaintenance({
            // pg_stat_user_tables updates n_dead_tup asynchronously. Zero gates
            // make this real-database proof deterministic while still exercising
            // both maintenance predicates against the sampled statistics.
            minimumDeadTupleRatio: 0,
            minimumDeadTuples: 0,
            minimumTableBytes: 0,
            now: new Date("2026-09-03T02:00:00.000Z"),
            window: { endMinute: 180, startMinute: 60 },
          });
          const reindexableIndexes = [
            "idx_pg_lexical_search_document",
            "idx_pg_lexical_search_scope_document",
            "idx_pg_semantic_search_scope",
            "idx_pg_semantic_search_embedding_hnsw",
          ];
          const presentIndexes = await postgresQuery<{ relname: string }>(
            `SELECT index_class.relname
               FROM pg_class AS index_class
               JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
              WHERE namespace.nspname = current_schema()
                AND index_class.relname = ANY($1::text[])
              ORDER BY index_class.relname`,
            [reindexableIndexes]
          );
          const after = await postgresQuery<{ index_oid: string; last_analyze: string | null; last_vacuum: string | null }>(
            `SELECT stats.last_vacuum::text AS last_vacuum,
                    stats.last_analyze::text AS last_analyze,
                    index_class.oid::text AS index_oid
               FROM pg_stat_user_tables AS stats
               JOIN pg_class AS index_class ON index_class.relname = 'idx_pg_lexical_search_document'
               JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
              WHERE stats.schemaname = current_schema()
                AND stats.relname = 'lexical_search_index'
                AND index_namespace.nspname = current_schema()`
          );

          assert.equal(receipt.status, "completed");
          assert.deepEqual(
            receipt.tables.map((table) => table.tableName),
            ["blobs", "lexical_search_index", "record_changes", "records", "semantic_search_blob", "spine_events"],
            "the scheduled vacuum samples every known heavy table"
          );
          assert.ok(receipt.tables.some((table) => table.tableName === "lexical_search_index" && table.vacuumed));
          assert.deepEqual(
            [...receipt.reindexedIndexNames].sort(),
            presentIndexes.rows.map((row) => row.relname),
            "only present indexes from the static search-index allowlist are rebuilt"
          );
          assert.deepEqual(getLastPostgresDerivedIndexMaintenanceReceipt(), receipt);
          assert.ok(after.rows[0]?.last_vacuum, "VACUUM (ANALYZE) updates Postgres's manual vacuum statistic");
          assert.ok(after.rows[0]?.last_analyze, "VACUUM (ANALYZE) updates Postgres's analyze statistic");
          assert.notEqual(after.rows[0]?.index_oid, before.rows[0]?.index_oid, "REINDEX CONCURRENTLY replaces the index relation");

          const repeat = await runPostgresDerivedIndexMaintenance({
            minimumDeadTupleRatio: 0,
            minimumDeadTuples: 0,
            minimumTableBytes: 0,
            now: new Date("2026-09-03T02:15:00.000Z"),
            window: { endMinute: 180, startMinute: 60 },
          });
          assert.equal(repeat.status, "already-completed", "the scheduler runs no more than once in one UTC window");
          const outsideWindow = await runPostgresDerivedIndexMaintenance({
            now: new Date("2026-09-03T04:00:00.000Z"),
            window: { endMinute: 180, startMinute: 60 },
          });
          assert.equal(outsideWindow.status, "outside-window");
          assert.deepEqual(
            getLastPostgresDerivedIndexMaintenanceReceipt(),
            receipt,
            "routine outside-window polls do not hide the most recent completed maintenance receipt"
          );
        } finally {
          await closePostgresStorage();
        }
      }
    );
  });

  // Shared setup for the cross-process cases: one database whose VACUUM of
  // semantic_search_blob outlasts every deadline below, and a separate Node
  // process that runs the real maintenance code against it, like a previous or
  // sibling app instance.
  const maintenanceWindow = { endMinute: 180, startMinute: 60 };
  const maintenanceNow = "2026-09-03T02:00:00.000Z";
  const semanticVacuumQuery = 'VACUUM (ANALYZE) "semantic_search_blob"';

  const withSlowSemanticVacuumDatabase = async (
    callback: (context: {
      activeSemanticVacuums: () => Promise<number[]>;
      admin: pg.Client;
      databaseName: string;
      databaseUrl: string;
      startMaintenanceProcess: () => Promise<MaintenanceProcess>;
    }) => Promise<void>
  ): Promise<void> => {
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName: databaseName() },
      async (databaseUrl) => {
        const name = new URL(databaseUrl).pathname.slice(1);
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        const childAttachment = await createAlreadyAdmittedTestDatabaseChildAttachment(databaseUrl);
        await postgresQuery(
          `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
           SELECT 'connector', 'instance', 'scope', 'record-' || series::text, '[0.1,0.2]'
             FROM generate_series(1, 50000) AS series`
        );
        await closePostgresStorage();
        const admin = new pg.Client({ connectionString: databaseUrl });
        await admin.connect();
        const children: ReturnType<typeof spawn>[] = [];
        try {
          // The throttle stands in for production table size (14 GB, 41+ min).
          await admin.query(`ALTER DATABASE "${name}" SET vacuum_cost_delay = '100ms'`);
          await admin.query(`ALTER DATABASE "${name}" SET vacuum_cost_limit = 1`);
          const activeSemanticVacuums = async () =>
            (
              await admin.query<{ pid: number }>(
                `SELECT pid FROM pg_stat_activity
                  WHERE datname = $1 AND backend_type = 'client backend' AND query = $2`,
                [name, semanticVacuumQuery]
              )
            ).rows.map((row) => row.pid);
          const startMaintenanceProcess = async (): Promise<MaintenanceProcess> => {
            const program = `
              import { initPostgresStorage } from "./server/postgres-storage.ts";
              import { runPostgresDerivedIndexMaintenance } from "./server/postgres-derived-index-maintenance.ts";
              await initPostgresStorage(
                { backend: "postgres", databaseUrl: process.env.PDPP_SLOW_VACUUM_URL },
                { testOnlyAlreadyAdmittedChildAttachment: process.env.PDPP_SLOW_VACUUM_CHILD_ATTACHMENT }
              );
              try {
                const receipt = await runPostgresDerivedIndexMaintenance({
                  minimumDeadTupleRatio: 0,
                  minimumDeadTuples: 0,
                  minimumTableBytes: 0,
                  now: new Date(${JSON.stringify(maintenanceNow)}),
                  window: ${JSON.stringify(maintenanceWindow)},
                });
                console.log(JSON.stringify({ status: receipt.status }));
              } catch (error) {
                console.log(JSON.stringify({ error: error.message }));
              }
              process.exit(0);
            `;
            const loaderArgs = process.env.PDPP_TEST_COMPAT_LOADER
              ? ["--experimental-loader", process.env.PDPP_TEST_COMPAT_LOADER]
              : [];
            const child = spawn(
              process.execPath,
              [...loaderArgs, "--import", "tsx", "--input-type=module", "--eval", program],
              {
                cwd: path.resolve(import.meta.dirname, ".."),
                env: {
                  ...process.env,
                  PDPP_SLOW_VACUUM_CHILD_ATTACHMENT: childAttachment,
                  PDPP_SLOW_VACUUM_URL: databaseUrl,
                },
                stdio: ["ignore", "pipe", "pipe"],
              }
            );
            children.push(child);
            let stdout = "";
            let stderr = "";
            child.stdout?.on("data", (chunk) => (stdout += chunk));
            child.stderr?.on("data", (chunk) => (stderr += chunk));
            const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
            const deadline = Date.now() + 60_000;
            while ((await activeSemanticVacuums()).length === 0) {
              assert.ok(Date.now() < deadline, `maintenance never reached ${semanticVacuumQuery}: ${stderr}`);
              assert.equal(child.exitCode, null, `maintenance process exited early: ${stdout}${stderr}`);
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return {
              kill: async () => {
                child.kill("SIGKILL");
                await exited;
              },
              outcome: async () => {
                await exited;
                return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { error?: string; status?: string };
              },
            };
          };
          await callback({ activeSemanticVacuums, admin, databaseName: name, databaseUrl, startMaintenanceProcess });
        } finally {
          for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }
          await admin.end();
          await closePostgresStorage();
        }
      }
    );
  };

  /** Boots the schema, or reports "blocked" after the deadline and unblocks the boot. */
  async function bootWithDeadline(
    databaseUrl: string,
    admin: pg.Client,
    name: string,
    log: (message: string) => void
  ): Promise<{ elapsedMs: number; outcome: "blocked" | "booted" }> {
    const startedAt = Date.now();
    const boot = initPostgresStorage({ backend: "postgres", databaseUrl }, { log }).then(() => "booted" as const);
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      boot,
      new Promise<"blocked">((resolve) => {
        timer = setTimeout(() => resolve("blocked"), 30_000);
      }),
    ]);
    clearTimeout(timer);
    const elapsedMs = Date.now() - startedAt;
    if (outcome === "blocked") {
      // Free the boot so the caller's assertion reports instead of hanging.
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND query = $2", [
        name,
        semanticVacuumQuery,
      ]);
      await boot.catch(() => undefined);
    }
    return { elapsedMs, outcome };
  }

  test("the VACUUM of a killed maintenance process ends by itself and does not block the next boot", async () => {
    await withSlowSemanticVacuumDatabase(async (database) => {
      const { activeSemanticVacuums, admin, databaseName: name, databaseUrl, startMaintenanceProcess } = database;
      const previousProcess = await startMaintenanceProcess();
      const [orphanPid] = await activeSemanticVacuums();
      await previousProcess.kill();

      // No new process touches the database yet: the server alone must notice
      // that the client is gone.
      const deadline = Date.now() + 20_000;
      while ((await activeSemanticVacuums()).length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.deepEqual(
        await activeSemanticVacuums(),
        [],
        `orphaned VACUUM pid ${orphanPid} still runs 20s after its client died`
      );

      const boot = await bootWithDeadline(databaseUrl, admin, name, () => undefined);
      assert.equal(boot.outcome, "booted", `boot waited ${boot.elapsedMs}ms behind the dead process's VACUUM`);

      const rerun = await runPostgresDerivedIndexMaintenance({
        now: new Date(maintenanceNow),
        window: maintenanceWindow,
      });
      assert.equal(rerun.status, "already-attempted", "an interrupted window is not retried");
      const receipts = await postgresQuery<{ error_text: string | null; status: string }>(
        "SELECT status, error_text FROM postgres_derived_index_maintenance_receipts"
      );
      assert.equal(receipts.rows.length, 1);
      assert.equal(receipts.rows[0]?.status, "failed", "the dead run's 'running' receipt is reconciled");
      assert.match(receipts.rows[0]?.error_text ?? "", /interrupted/);
    });
  });

  test("a boot cancels a live sibling process's maintenance VACUUM instead of waiting behind it", async () => {
    await withSlowSemanticVacuumDatabase(async (database) => {
      const { activeSemanticVacuums, admin, databaseName: name, databaseUrl, startMaintenanceProcess } = database;
      const sibling = await startMaintenanceProcess();
      const [vacuumPid] = await activeSemanticVacuums();
      const bootLog: string[] = [];

      const boot = await bootWithDeadline(databaseUrl, admin, name, (message) => bootLog.push(message));
      assert.equal(boot.outcome, "booted", `boot waited ${boot.elapsedMs}ms behind the sibling's VACUUM`);
      assert.ok(
        bootLog.some((message) => message.includes(`cancelled derived-index maintenance in backend pid ${vacuumPid}`)),
        `the boot log names the cancelled backend: ${bootLog.join("\n")}`
      );
      const outcome = await sibling.outcome();
      assert.match(outcome.error ?? "", /canceling statement/, "the sibling's run fails instead of completing");
      const receipts = await postgresQuery<{ error_text: string | null; status: string }>(
        "SELECT status, error_text FROM postgres_derived_index_maintenance_receipts"
      );
      assert.equal(receipts.rows[0]?.status, "failed", "the live run records its own cancellation");
    });
  });

  test("derived-index maintenance does not start while a schema bootstrap holds its lock", async () => {
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName: databaseName() },
      async (databaseUrl) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        const bootstrap = new pg.Client({ connectionString: databaseUrl });
        await bootstrap.connect();
        try {
          await bootstrap.query("SELECT pg_advisory_lock(482571, 150)");
          const receipt = await runPostgresDerivedIndexMaintenance({
            minimumTableBytes: 0,
            now: new Date(maintenanceNow),
            window: maintenanceWindow,
          });
          assert.equal(receipt.status, "bootstrap-pending");
          const receipts = await postgresQuery("SELECT 1 FROM postgres_derived_index_maintenance_receipts");
          assert.equal(receipts.rowCount, 0, "a skipped run claims no window");
        } finally {
          await bootstrap.end();
          await closePostgresStorage();
        }
      }
    );
  });

  test("derived-index maintenance VACUUM gives up on a held table lock instead of queueing", async () => {
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName: databaseName() },
      async (databaseUrl) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        const holder = new pg.Client({ connectionString: databaseUrl });
        await holder.connect();
        try {
          await holder.query("BEGIN");
          await holder.query("LOCK TABLE blobs IN SHARE UPDATE EXCLUSIVE MODE");
          const run = runPostgresDerivedIndexMaintenance({
            minimumTableBytes: 0,
            now: new Date(maintenanceNow),
            window: maintenanceWindow,
          }).then(
            (receipt) => receipt.status,
            (error: unknown) => (error instanceof Error ? error.message : String(error))
          );
          let timer: NodeJS.Timeout | undefined;
          const outcome = await Promise.race([
            run,
            new Promise<"still waiting">((resolve) => {
              timer = setTimeout(() => resolve("still waiting"), 20_000);
            }),
          ]);
          clearTimeout(timer);
          if (outcome === "still waiting") {
            // Release the lock so the run ends before the assertion reports.
            await holder.query("ROLLBACK");
            await run;
          }
          assert.match(outcome, /lock timeout/, "the VACUUM stopped waiting within its lock timeout");
          const receipts = await postgresQuery<{ status: string }>(
            "SELECT status FROM postgres_derived_index_maintenance_receipts"
          );
          assert.equal(receipts.rows[0]?.status, "failed");
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          await holder.end();
          await closePostgresStorage();
        }
      }
    );
  });
} else {
  test("derived-index maintenance (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    /* intentionally empty */
  });
}
