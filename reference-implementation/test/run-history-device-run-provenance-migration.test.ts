// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The older spine writer left scheduler_managed unset, so the legacy
// `DEFAULT true` / `DEFAULT 1` stamped device rows as scheduler-managed. The
// boot migration repairs those rows, and the current writer sets false on its
// own inserts so the legacy default cannot stamp later runs again.
//
// Proves, on both backends and on a table built the legacy way:
//   - the spine writer records a device run with the flag false;
//   - the boot migration flips an existing device row (matched by the
//     local_device spine event for the same run AND connection, including
//     identity that exists only in data_json, and leaves server rows alone,
//     including a row of another connection that shares the run_id;
//   - the pass is ledgered: a later boot skips it;
//   - on Postgres, the column default is false afterwards and the pass pages.

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { RUN_HISTORY_DEVICE_RUN_PROVENANCE_MIGRATION_ID } from "../server/postgres-migration-ledger.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { writeSqliteRunHistoryForSpineEvent } from "../server/stores/run-history-writer.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const CONNECTOR_ID = "claude-code";
const DEVICE_INSTANCE = "cin_device";
const SERVER_INSTANCE = "cin_server";
const OTHER_INSTANCE = "cin_other";
const NOW = "2026-10-22T12:00:00.000Z";

interface RunSpec {
  readonly instance: string;
  readonly runId: string | null;
  /** The spine event written for the run, if any. */
  readonly spine?: {
    readonly actorType: string;
    /** `data_json` carries the connection id; otherwise only the column does. */
    readonly identity: "column" | "data";
  };
}

// scheduler_managed is true on every row: the legacy default stamped it.
const RUNS: readonly RunSpec[] = [
  { instance: DEVICE_INSTANCE, runId: "run-device-data", spine: { actorType: "local_device", identity: "data" } },
  { instance: DEVICE_INSTANCE, runId: "run-device-column", spine: { actorType: "local_device", identity: "column" } },
  { instance: SERVER_INSTANCE, runId: "run-server", spine: { actorType: "runtime", identity: "data" } },
  { instance: SERVER_INSTANCE, runId: "run-server-no-spine" },
  // Another connection minted the same run_id as a device run; its row is a server row.
  { instance: OTHER_INSTANCE, runId: "run-device-data", spine: { actorType: "runtime", identity: "data" } },
  { instance: DEVICE_INSTANCE, runId: null },
];
const DEVICE_RUNS = new Set([`${DEVICE_INSTANCE}/run-device-data`, `${DEVICE_INSTANCE}/run-device-column`]);

function spineParams(spec: RunSpec, index: number) {
  assert.ok(spec.spine && spec.runId, "only runs with a spine event are seeded into the spine");
  const dataJson = JSON.stringify(spec.spine.identity === "data" ? { connector_instance_id: spec.instance } : {});
  return {
    columnInstance: spec.spine.identity === "column" ? spec.instance : null,
    dataJson,
    eventId: `evt_provenance_${index}`,
  };
}

function key(row: { connector_instance_id: string; run_id: string | null }): string {
  return `${row.connector_instance_id}/${row.run_id}`;
}

function isStamped(value: unknown): boolean {
  return value === true || value === 1;
}

function seedSqlite(): void {
  const db = getDb();
  db.exec("DROP TABLE run_history");
  db.exec(`
    CREATE TABLE run_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      connector_instance_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      trigger_kind TEXT,
      source_json TEXT NOT NULL,
      status TEXT NOT NULL,
      records_emitted INTEGER NOT NULL DEFAULT 0,
      reported_records_emitted INTEGER,
      checkpoint_summary_json TEXT,
      known_gaps_json TEXT NOT NULL DEFAULT '[]',
      connector_error_json TEXT,
      trace_id TEXT,
      failure_reason TEXT,
      terminal_reason TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      facts_json TEXT,
      scheduler_managed INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_run_history_connector_completed ON run_history(connector_id, completed_at, id);
    CREATE UNIQUE INDEX uniq_run_history_run_id_instance
      ON run_history(run_id, connector_instance_id) WHERE run_id IS NOT NULL;
  `);
  RUNS.forEach((spec, index) => {
    db.prepare(
      `INSERT INTO run_history(connector_instance_id, connector_id, source_json, status, started_at, completed_at, run_id)
       VALUES (?, ?, '{}', 'succeeded', ?, ?, ?)`
    ).run(spec.instance, CONNECTOR_ID, NOW, NOW, spec.runId);
    if (!spec.spine) {
      return;
    }
    const spine = spineParams(spec, index);
    db.prepare(
      `INSERT INTO spine_events(
         event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id, actor_type, actor_id,
         object_type, object_id, status, run_id, data_json, version, connector_instance_id
       ) VALUES (?, 'run.completed', ?, ?, 'scenario', 'trace', ?, 'actor', 'run', ?, 'succeeded', ?, ?, '1', ?)`
    ).run(spine.eventId, NOW, NOW, spec.spine.actorType, spec.runId, spec.runId, spine.dataJson, spine.columnInstance);
    if (spec.spine.identity === "data") {
      db.prepare("UPDATE spine_events SET connector_instance_id = NULL WHERE event_id = ?").run(spine.eventId);
    }
  });
}

function sqliteFlags(): Map<string, boolean> {
  const rows = getDb().prepare("SELECT connector_instance_id, run_id, scheduler_managed FROM run_history").all() as {
    connector_instance_id: string;
    run_id: string | null;
    scheduler_managed: number;
  }[];
  return new Map(rows.map((row) => [key(row), isStamped(row.scheduler_managed)]));
}

function assertFlags(flags: Map<string, boolean>): void {
  for (const spec of RUNS) {
    const id = key({ connector_instance_id: spec.instance, run_id: spec.runId });
    assert.equal(
      flags.get(id),
      !DEVICE_RUNS.has(id),
      DEVICE_RUNS.has(id)
        ? `${id}: a device run is not scheduler-managed`
        : `${id}: a row without a local_device event for this connection keeps its flag`
    );
  }
}

test("SQLite: the migration flips device runs only, is ledgered, and the spine writer stamps device runs false", () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-device-provenance-");
  initDb(dbPath);
  seedSqlite();
  const sqliteDataOnlyIdentity = getDb()
    .prepare("SELECT connector_instance_id FROM spine_events WHERE event_id = 'evt_provenance_0'")
    .get() as { connector_instance_id: string | null };
  assert.equal(sqliteDataOnlyIdentity.connector_instance_id, null, "identity is only in data_json");
  // A database from before the receipt existed.
  const dropReceipt = getDb().prepare("DELETE FROM storage_migration_ledger WHERE migration_id = ?");
  dropReceipt.run(RUN_HISTORY_DEVICE_RUN_PROVENANCE_MIGRATION_ID);
  closeDb();

  initDb(dbPath);
  try {
    assertFlags(sqliteFlags());
    const receipt = getDb()
      .prepare("SELECT status, changed_rows FROM storage_migration_ledger WHERE migration_id = ?")
      .get(RUN_HISTORY_DEVICE_RUN_PROVENANCE_MIGRATION_ID) as { changed_rows: number; status: string };
    assert.deepEqual({ ...receipt }, { changed_rows: DEVICE_RUNS.size, status: "complete" });

    // The receipt retires the pass: a row flipped back is not touched by the next boot.
    getDb().prepare("UPDATE run_history SET scheduler_managed = 1").run();
  } finally {
    closeDb();
  }
  initDb(dbPath);
  try {
    assert.ok([...sqliteFlags().values()].every(Boolean), "a boot with a COMPLETE receipt does not rerun the pass");

    // The table still defaults to 1 (SQLite cannot change a default in place), so the
    // writer's own insert is what keeps a device run from being stamped true.
    const started = {
      actorType: "runtime",
      connectorId: CONNECTOR_ID,
      connectorInstanceId: DEVICE_INSTANCE,
      data: {},
      eventType: "run.started",
      occurredAt: NOW,
      runId: "run-written-by-spine-writer",
      status: "started",
    };
    writeSqliteRunHistoryForSpineEvent(started);
    writeSqliteRunHistoryForSpineEvent({
      ...started,
      eventType: "run.completed",
      runId: "run-finalized-by-spine-writer",
      status: "succeeded",
    });
    const rows = getDb()
      .prepare("SELECT run_id, scheduler_managed FROM run_history WHERE run_id LIKE 'run-%-by-spine-writer'")
      .all() as { run_id: string; scheduler_managed: number }[];
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.scheduler_managed, 0, `${row.run_id}: the writer sets the flag itself`);
    }
  } finally {
    closeDb();
  }
});

let tempDbCounter = 0;

test("PostgreSQL: the boot migration repairs the column default and device rows, pages, and is ledgered", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  tempDbCounter += 1;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_rh_device_prov_${process.pid}_${tempDbCounter}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      // A database whose column was added later: the default is true.
      await postgresQuery("ALTER TABLE run_history ALTER COLUMN scheduler_managed SET DEFAULT true");
      await postgresQuery("DELETE FROM storage_migration_ledger WHERE migration_id = $1", [
        RUN_HISTORY_DEVICE_RUN_PROVENANCE_MIGRATION_ID,
      ]);
      // Filler spans more than one page, so device rows land in the first, a middle and the last page.
      const filler = await postgresQuery(
        `INSERT INTO run_history(connector_instance_id, connector_id, source_json, status, started_at, completed_at, run_id)
         SELECT $1, $2, '{}'::jsonb, 'succeeded', $3, $3, 'run-filler-' || n
           FROM generate_series(1, 4500) AS n`,
        [SERVER_INSTANCE, CONNECTOR_ID, NOW]
      );
      assert.equal(filler.rowCount, 4500);
      for (const [index, spec] of RUNS.entries()) {
        // biome-ignore lint/performance/noAwaitInLoops: a handful of fixture rows.
        await postgresQuery(
          `INSERT INTO run_history(connector_instance_id, connector_id, source_json, status, started_at, completed_at, run_id)
           VALUES ($1, $2, '{}'::jsonb, 'succeeded', $3, $3, $4)`,
          [spec.instance, CONNECTOR_ID, NOW, spec.runId]
        );
        if (spec.spine) {
          const spine = spineParams(spec, index);
          // biome-ignore lint/performance/noAwaitInLoops: a handful of fixture rows.
          await postgresQuery(
            `INSERT INTO spine_events(
               event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id, actor_type, actor_id,
               object_type, object_id, status, run_id, data_json, version, connector_instance_id
             ) VALUES ($1, 'run.completed', $2, $2, 'scenario', 'trace', $3, 'actor', 'run', $4, 'succeeded', $4, $5::jsonb, '1', $6)`,
            [spine.eventId, NOW, spec.spine.actorType, spec.runId, spine.dataJson, spine.columnInstance]
          );
          if (spec.spine.identity === "data") {
            // The insert trigger promotes JSON identity on new rows; clear the
            // column to model a historical row written before that trigger.
            await postgresQuery("UPDATE spine_events SET connector_instance_id = NULL WHERE event_id = $1", [
              spine.eventId,
            ]);
          }
        }
        // Push the next fixture row into a later page.
        // biome-ignore lint/performance/noAwaitInLoops: a handful of fixture rows.
        await postgresQuery(
          `INSERT INTO run_history(connector_instance_id, connector_id, source_json, status, started_at, completed_at, run_id)
           SELECT $1, $2, '{}'::jsonb, 'succeeded', $3, $3, 'run-gap-${index}-' || n FROM generate_series(1, 700) AS n`,
          [SERVER_INSTANCE, CONNECTOR_ID, NOW]
        );
      }
      const postgresDataOnlyIdentity = await postgresQuery<{ connector_instance_id: string | null }>(
        "SELECT connector_instance_id FROM spine_events WHERE event_id = 'evt_provenance_0'"
      );
      assert.equal(postgresDataOnlyIdentity.rows[0]?.connector_instance_id, null, "identity is only in data_json");

      const flags = async (): Promise<Map<string, boolean>> => {
        const result = await postgresQuery<{
          connector_instance_id: string;
          run_id: string | null;
          scheduler_managed: boolean;
        }>(
          `SELECT connector_instance_id, run_id, scheduler_managed FROM run_history
            WHERE run_id IS NULL OR run_id NOT LIKE 'run-filler-%' AND run_id NOT LIKE 'run-gap-%'`
        );
        return new Map(result.rows.map((row) => [key(row), row.scheduler_managed]));
      };
      const columnDefault = async (): Promise<string | null> =>
        (
          await postgresQuery<{ column_default: string | null }>(
            `SELECT column_default FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'run_history' AND column_name = 'scheduler_managed'`
          )
        ).rows[0]?.column_default ?? null;
      assert.equal(await columnDefault(), "true", "premise: the legacy default is true");
      assert.ok([...(await flags()).values()].every(Boolean), "premise: every fixture row is stamped true");

      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });

      assertFlags(await flags());
      assert.equal(await columnDefault(), "false", "the column default is the fresh-schema value");
      const filled = await postgresQuery<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM run_history WHERE run_id LIKE 'run-filler-%' AND NOT scheduler_managed"
      );
      assert.equal(filled.rows[0]?.n, "0", "server rows are not touched");
      const receipt = await postgresQuery<{ changed_rows: string; cursor: string; status: string }>(
        "SELECT status, changed_rows::text AS changed_rows, cursor FROM storage_migration_ledger WHERE migration_id = $1",
        [RUN_HISTORY_DEVICE_RUN_PROVENANCE_MIGRATION_ID]
      );
      const maxId = await postgresQuery<{ id: string }>("SELECT MAX(id)::text AS id FROM run_history");
      assert.deepEqual(
        { ...receipt.rows[0] },
        { changed_rows: String(DEVICE_RUNS.size), cursor: maxId.rows[0]?.id, status: "complete" },
        "the receipt counts the flipped rows and its cursor reached the last page"
      );

      // A row written without the column now defaults to false.
      await postgresQuery(
        `INSERT INTO run_history(connector_instance_id, connector_id, source_json, status, started_at, run_id)
         VALUES ($1, $2, '{}'::jsonb, 'running', $3, 'run-after-default-fix')`,
        [DEVICE_INSTANCE, CONNECTOR_ID, NOW]
      );
      const written = await postgresQuery<{ scheduler_managed: boolean }>(
        "SELECT scheduler_managed FROM run_history WHERE run_id = 'run-after-default-fix'"
      );
      assert.equal(written.rows[0]?.scheduler_managed, false);

      // The receipt retires the pass on the next boot.
      await postgresQuery("UPDATE run_history SET scheduler_managed = true");
      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const rerun = await postgresQuery<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM run_history WHERE NOT scheduler_managed"
      );
      assert.equal(rerun.rows[0]?.n, "0", "a boot with a COMPLETE receipt does not rerun the pass");
      assert.equal(await columnDefault(), "false", "the default stays repaired across boots");
    }
  );
});
