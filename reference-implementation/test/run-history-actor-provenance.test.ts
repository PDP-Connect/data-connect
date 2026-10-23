// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Run provenance: `run_history.actor_type`, the actor_type of a run's terminal
// spine event.
//
// Why it exists: coverage must credit a device terminal only while the
// connection is `local_device`. The stream-facts fold decides that from the
// spine event's actor_type, but the run-history selector works from
// `run_history` rows, which did not record it. A device terminal written before
// collection revisions carries no revision stamp and no marker, so the selector
// could not tell it from a server run.
//
// Covers, on SQLite and real PostgreSQL where a dedicated test database is
// available:
//   - the migration adds the column to an existing run_history,
//   - the live writer records the terminal event's actor_type, and the
//     scheduler's own append records `runtime`,
//   - the startup backfill fills historical rows (idempotent, batched, bounded),
//   - the coverage selector's rule for device, server, and unknown provenance.
// The end-to-end half (a pre-revision device terminal on a browser_collector
// connection) is in local-device-coverage-revision-atomicity.test.ts.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { projectCollectionReport, type RuntimeCollectionFact } from "../server/ref-control.ts";
import {
  type RunHistoryActorBackfillRound,
  runRunHistoryActorBackfillRound,
  runStartupRunHistoryActorBackfillToCompletion,
  SQLITE_FILL_ACTOR_SQL,
} from "../server/stores/run-history-actor-backfill.ts";
import { runRunHistoryBackfillRound } from "../server/stores/run-history-backfill-stage.ts";
import { createSchedulerStore, type SchedulerRunHistoryRecord } from "../server/stores/scheduler-store.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

type Backend = "postgres" | "sqlite";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset";
const BACKENDS: readonly Backend[] = ["sqlite", "postgres"];
const CONNECTOR_ID = "provenance_connector";
const INSTANCE_A = "cin_provenance_a";
const INSTANCE_B = "cin_provenance_b";
const READS = /^\s*SELECT\b/i;

let databaseCounter = 0;
let sqlitePath = "";

async function withBackend(backend: Backend, body: () => Promise<void>): Promise<void> {
  if (backend === "sqlite") {
    const dir = await mkdtemp(join(tmpdir(), "pdpp-run-actor-"));
    sqlitePath = join(dir, "pdpp.sqlite");
    initDb(sqlitePath);
    try {
      await body();
    } finally {
      closeDb();
      await rm(dir, { force: true, recursive: true });
    }
    return;
  }
  assert.ok(POSTGRES_URL, "the Postgres lane requires PDPP_TEST_POSTGRES_URL");
  databaseCounter += 1;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_run_actor_${process.pid}_${databaseCounter}`,
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      try {
        await body();
      } finally {
        await closePostgresStorage();
      }
    }
  );
}

/** One test per backend. The Postgres one skips without a dedicated test database. */
function backendTest(name: string, body: (backend: Backend) => Promise<void>): void {
  for (const backend of BACKENDS) {
    test(
      backend === "postgres" ? `${name} [real PostgreSQL]` : name,
      { skip: backend === "postgres" ? POSTGRES_SKIP : false },
      () => withBackend(backend, () => body(backend))
    );
  }
}

/** Run a statement on the backend. Postgres takes `$n` placeholders; SQLite takes `?`. */
async function sql(backend: Backend, sqlite: string, postgres: string, params: unknown[] = []) {
  if (backend === "postgres") {
    return (await postgresQuery(postgres, params)).rows as Record<string, unknown>[];
  }
  const statement = getDb().prepare(sqlite);
  if (READS.test(sqlite)) {
    return statement.all(...params) as Record<string, unknown>[];
  }
  statement.run(...params);
  return [];
}

function startedEvent(runId: string, connectorInstanceId: string) {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      boot_epoch: "boot-run-actor-provenance",
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      seq: 1,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_id: `evt_${connectorInstanceId}_${runId}_started`,
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status: "started",
  };
}

type TerminalType = "run.browser_surface_failed" | "run.cancelled" | "run.completed" | "run.failed";

function terminalEvent(
  runId: string,
  connectorInstanceId: string,
  actorType: string,
  eventType: TerminalType = "run.completed",
  suffix = "terminal"
) {
  return {
    actor_id: actorType === "local_device" ? "device-1" : CONNECTOR_ID,
    actor_type: actorType,
    data: {
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      records_emitted: 1,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_id: `evt_${connectorInstanceId}_${runId}_${suffix}`,
    event_type: eventType,
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status: eventType === "run.completed" ? "succeeded" : "failed",
  };
}

async function actorTypeOf(backend: Backend, runId: string, instance: string): Promise<unknown> {
  const [row] = await sql(
    backend,
    "SELECT actor_type FROM run_history WHERE run_id = ? AND connector_instance_id = ?",
    "SELECT actor_type FROM run_history WHERE run_id = $1 AND connector_instance_id = $2",
    [runId, instance]
  );
  assert.ok(row, `${instance}/${runId} has a run_history row`);
  return row.actor_type;
}

/** Rows as a server that predates the column left them. */
async function clearProvenance(backend: Backend): Promise<void> {
  await sql(backend, "UPDATE run_history SET actor_type = NULL", "UPDATE run_history SET actor_type = NULL");
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

backendTest("migration: an existing run_history gains a nullable actor_type and keeps its rows", async (backend) => {
  await emitSpineEvent(startedEvent("run-kept", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-kept", INSTANCE_A, "runtime"));
  await sql(
    backend,
    "ALTER TABLE run_history DROP COLUMN actor_type",
    "ALTER TABLE run_history DROP COLUMN actor_type"
  );
  const dropped = await sql(
    backend,
    "SELECT name FROM pragma_table_info('run_history') WHERE name = 'actor_type'",
    "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'run_history' AND column_name = 'actor_type'"
  );
  assert.equal(dropped.length, 0, "the fixture is a run_history from before the column");

  if (backend === "postgres") {
    await bootstrapPostgresSchema();
  } else {
    // SQLite migrates on open: reopen the same file.
    closeDb();
    initDb(sqlitePath);
  }

  const [column] = await sql(
    backend,
    "SELECT \"notnull\" AS not_null, type FROM pragma_table_info('run_history') WHERE name = 'actor_type'",
    "SELECT (is_nullable = 'NO')::int AS not_null, data_type AS type FROM information_schema.columns WHERE table_name = 'run_history' AND column_name = 'actor_type'"
  );
  assert.ok(column, "the migration adds the column");
  assert.equal(Number(column.not_null), 0, "the column is nullable");
  assert.equal(String(column.type).toLowerCase(), "text");
  assert.equal(await actorTypeOf(backend, "run-kept", INSTANCE_A), null, "an existing row reads NULL, not a guess");
  const rows = await sql(
    backend,
    "SELECT COUNT(*) AS n FROM run_history",
    "SELECT COUNT(*)::int AS n FROM run_history"
  );
  assert.equal(Number(rows[0]?.n), 1, "the migration keeps the existing row");
});

// ---------------------------------------------------------------------------
// Live writer
// ---------------------------------------------------------------------------

backendTest("writer: a terminal event's actor_type is recorded on its run_history row", async (backend) => {
  await emitSpineEvent(startedEvent("run-device", INSTANCE_A));
  assert.equal(await actorTypeOf(backend, "run-device", INSTANCE_A), null, "a running row has no provenance yet");
  await emitSpineEvent(terminalEvent("run-device", INSTANCE_A, "local_device"));
  assert.equal(await actorTypeOf(backend, "run-device", INSTANCE_A), "local_device");

  await emitSpineEvent(startedEvent("run-server", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-server", INSTANCE_A, "runtime"));
  assert.equal(await actorTypeOf(backend, "run-server", INSTANCE_A), "runtime");

  // The fallback insert (no prior run.started row) records it too.
  await emitSpineEvent(terminalEvent("run-no-start", INSTANCE_A, "local_device", "run.failed"));
  assert.equal(await actorTypeOf(backend, "run-no-start", INSTANCE_A), "local_device");

  // A later terminal event for a finalized run changes nothing.
  await emitSpineEvent(terminalEvent("run-device", INSTANCE_A, "runtime", "run.failed", "second"));
  assert.equal(await actorTypeOf(backend, "run-device", INSTANCE_A), "local_device");
});

backendTest("row backfill: a run the stage inserts from spine carries its terminal event's actor", async (backend) => {
  await emitSpineEvent(startedEvent("run-lost-device", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-lost-device", INSTANCE_A, "local_device"));
  await emitSpineEvent(startedEvent("run-lost-server", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-lost-server", INSTANCE_A, "runtime"));
  // The runs predate the run_history writer: spine has them, run_history does not.
  await sql(backend, "DELETE FROM run_history", "DELETE FROM run_history");
  const round = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 10 });
  assert.equal(round.backfilled, 2);
  assert.equal(await actorTypeOf(backend, "run-lost-device", INSTANCE_A), "local_device");
  assert.equal(await actorTypeOf(backend, "run-lost-server", INSTANCE_A), "runtime");
});

backendTest("scheduler append: the scheduler's own run_history write records runtime provenance", async (backend) => {
  const store = createSchedulerStore();
  const record = (runId: string | null): SchedulerRunHistoryRecord => ({
    attempt: 1,
    checkpointSummary: null,
    completedAt: "2026-10-01T00:01:00.000Z",
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_A,
    knownGaps: [],
    recordsEmitted: 0,
    runId,
    source: { id: CONNECTOR_ID, kind: "connector" },
    startedAt: "2026-10-01T00:00:00.000Z",
    status: "skipped",
  });
  // A skipped run has no spine events: the append is its only writer.
  await store.appendRunHistory(record("run-skipped"));
  assert.equal(await actorTypeOf(backend, "run-skipped", INSTANCE_A), "runtime");

  // A row the spine writer already finalized keeps the actor it recorded.
  await emitSpineEvent(startedEvent("run-device-then-append", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-device-then-append", INSTANCE_A, "local_device"));
  await store.appendRunHistory(record("run-device-then-append"));
  assert.equal(await actorTypeOf(backend, "run-device-then-append", INSTANCE_A), "local_device");

  // A still-running row, which has no provenance yet, takes runtime when the scheduler settles it.
  await emitSpineEvent(startedEvent("run-running-then-append", INSTANCE_A));
  assert.equal(await actorTypeOf(backend, "run-running-then-append", INSTANCE_A), null);
  await store.appendRunHistory(record("run-running-then-append"));
  assert.equal(await actorTypeOf(backend, "run-running-then-append", INSTANCE_A), "runtime");
});

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/** Historical rows of every shape the backfill must handle; provenance cleared as before the column. */
async function seedHistoricalRows(backend: Backend): Promise<void> {
  // A run id two connections share: each row takes its own connection's terminal actor.
  await emitSpineEvent(startedEvent("run-shared", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-shared", INSTANCE_A, "local_device"));
  await emitSpineEvent(startedEvent("run-shared", INSTANCE_B));
  await emitSpineEvent(terminalEvent("run-shared", INSTANCE_B, "runtime"));
  await emitSpineEvent(startedEvent("run-server", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-server", INSTANCE_A, "runtime", "run.cancelled"));
  // The first terminal event is the one the live writer finalizes from.
  await emitSpineEvent(startedEvent("run-two-terminals", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-two-terminals", INSTANCE_A, "local_device"));
  await emitSpineEvent(terminalEvent("run-two-terminals", INSTANCE_A, "runtime", "run.failed", "second"));
  // A terminal with no run.started row, and a type outside the Postgres terminal partial index.
  await emitSpineEvent(terminalEvent("run-surface", INSTANCE_A, "runtime", "run.browser_surface_failed"));
  // Still running: not a candidate.
  await emitSpineEvent(startedEvent("run-running", INSTANCE_A));
  await clearProvenance(backend);
  // A terminal row whose run has no spine event at all: only the scheduler's own
  // append writes such a row, a server run by construction. It reads scheduler_managed
  // TRUE, the column default every row carries in production, device rows included.
  await sql(
    backend,
    `INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, started_at, completed_at)
     VALUES ('run-no-events', ?, ?, '{}', 'succeeded', '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z')`,
    `INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, started_at, completed_at)
     VALUES ('run-no-events', $1, $2, '{}'::jsonb, 'succeeded', '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z')`,
    [INSTANCE_A, CONNECTOR_ID]
  );
  // A row that already has provenance keeps it, whatever its spine event says.
  await emitSpineEvent(startedEvent("run-already-set", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-already-set", INSTANCE_A, "runtime"));
  await sql(
    backend,
    "UPDATE run_history SET actor_type = 'kept' WHERE run_id = 'run-already-set'",
    "UPDATE run_history SET actor_type = 'kept' WHERE run_id = 'run-already-set'"
  );
}

const EXPECTED_AFTER_BACKFILL: readonly (readonly [string, string, string | null])[] = [
  ["run-shared", INSTANCE_A, "local_device"],
  ["run-shared", INSTANCE_B, "runtime"],
  ["run-server", INSTANCE_A, "runtime"],
  ["run-two-terminals", INSTANCE_A, "local_device"],
  ["run-surface", INSTANCE_A, "runtime"],
  ["run-running", INSTANCE_A, null],
  ["run-no-events", INSTANCE_A, "runtime"],
  ["run-already-set", INSTANCE_A, "kept"],
];
// Candidates: terminal, NULL actor_type, run_id set. run-running and run-already-set are not.
const FILLABLE = 6;

async function assertBackfilled(backend: Backend, message: string): Promise<void> {
  for (const [runId, instance, expected] of EXPECTED_AFTER_BACKFILL) {
    // biome-ignore lint/performance/noAwaitInLoops: a handful of rows, read in order for a readable failure.
    assert.equal(await actorTypeOf(backend, runId, instance), expected, `${message}: ${instance}/${runId}`);
  }
}

backendTest(
  "backfill: historical rows take their run's earliest terminal actor, or runtime with no spine event, idempotently",
  async (backend) => {
    await seedHistoricalRows(backend);
    assert.equal(await actorTypeOf(backend, "run-shared", INSTANCE_A), null, "the fixture rows predate the column");
    const first = await runStartupRunHistoryActorBackfillToCompletion();
    assert.equal(first.complete, true);
    assert.equal(first.filled, FILLABLE);
    await assertBackfilled(backend, "after the first pass");

    // Every terminal row is filled, so a second pass reads and writes nothing.
    const second = await runStartupRunHistoryActorBackfillToCompletion();
    assert.equal(second.complete, true);
    assert.equal(second.filled, 0);
    assert.equal(second.examined, 0, "no row is re-examined once all are filled");
    await assertBackfilled(backend, "after the second pass");
  }
);

backendTest("backfill: the earliest terminal event by event_seq decides, whatever its type", async (backend) => {
  // run.browser_surface_failed is outside the Postgres terminal partial index; it must still
  // win when it comes first, and lose when a terminal of another type comes first.
  await emitSpineEvent(startedEvent("run-surface-first", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-surface-first", INSTANCE_A, "local_device", "run.browser_surface_failed"));
  await emitSpineEvent(terminalEvent("run-surface-first", INSTANCE_A, "runtime", "run.failed", "second"));
  await emitSpineEvent(startedEvent("run-surface-last", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-surface-last", INSTANCE_A, "runtime", "run.failed"));
  await emitSpineEvent(
    terminalEvent("run-surface-last", INSTANCE_A, "local_device", "run.browser_surface_failed", "second")
  );
  await clearProvenance(backend);
  const summary = await runStartupRunHistoryActorBackfillToCompletion();
  assert.equal(summary.filled, 2);
  assert.equal(await actorTypeOf(backend, "run-surface-first", INSTANCE_A), "local_device");
  assert.equal(await actorTypeOf(backend, "run-surface-last", INSTANCE_A), "runtime");
});

backendTest(
  "backfill: a settled row whose run has spine events but no terminal one stays NULL, never guessed",
  async (backend) => {
    await emitSpineEvent(startedEvent("run-no-terminal", INSTANCE_A));
    await sql(
      backend,
      "UPDATE run_history SET status = 'failed', completed_at = '2026-10-01T00:01:00.000Z' WHERE run_id = 'run-no-terminal'",
      "UPDATE run_history SET status = 'failed', completed_at = '2026-10-01T00:01:00.000Z' WHERE run_id = 'run-no-terminal'"
    );
    const summary = await runStartupRunHistoryActorBackfillToCompletion();
    assert.equal(summary.filled, 0);
    assert.equal(summary.examined, 1);
    assert.equal(await actorTypeOf(backend, "run-no-terminal", INSTANCE_A), null);
  }
);

backendTest(
  "backfill: rounds are bounded by the batch size, and a capped pass resumes where it left off",
  async (backend) => {
    await seedHistoricalRows(backend);
    const rounds: RunHistoryActorBackfillRound[] = [];
    const full = await runStartupRunHistoryActorBackfillToCompletion({
      batchSize: 2,
      onRound: (round) => rounds.push(round),
    });
    assert.ok(
      rounds.every((round) => round.examined <= 2),
      "no round examines more than the batch size"
    );
    assert.ok(rounds.length >= Math.ceil(FILLABLE / 2), "the work is split across rounds");
    assert.equal(full.rounds, rounds.length);
    assert.equal(full.filled, FILLABLE);
    await assertBackfilled(backend, "batched pass");

    // Reset and cap the pass: it stops early, and the next pass finishes.
    await seedResetForResume(backend);
    const capped = await runStartupRunHistoryActorBackfillToCompletion({ batchSize: 1, maxRounds: 2 });
    assert.equal(capped.complete, false, "a capped pass reports that it did not reach the end");
    assert.equal(capped.rounds, 2);
    assert.equal(capped.filled, 2, "two rounds of one row fill two rows");
    const resumed = await runStartupRunHistoryActorBackfillToCompletion({ batchSize: 1 });
    assert.equal(resumed.complete, true);
    assert.equal(capped.filled + resumed.filled, FILLABLE, "the two passes together fill every row once");
    await assertBackfilled(backend, "resumed pass");
  }
);

/** Clear the provenance the first pass filled, keeping the row that was set by hand. */
async function seedResetForResume(backend: Backend): Promise<void> {
  await sql(
    backend,
    "UPDATE run_history SET actor_type = NULL WHERE actor_type <> 'kept'",
    "UPDATE run_history SET actor_type = NULL WHERE actor_type <> 'kept'"
  );
}

backendTest("backfill: a round never touches a running row or overwrites a live value", async (backend) => {
  await seedHistoricalRows(backend);
  const round = await runRunHistoryActorBackfillRound({ afterId: 0, batchSize: 100 });
  assert.equal(round.filled, FILLABLE);
  assert.equal(await actorTypeOf(backend, "run-running", INSTANCE_A), null, "a running row is left to its live writer");
  assert.equal(await actorTypeOf(backend, "run-already-set", INSTANCE_A), "kept");
});

test("backfill: SQLite probes the terminal index by run, never the whole connection's events", async () => {
  await withBackend("sqlite", async () => {
    await seedHistoricalRows("sqlite");
    const plan = getDb()
      .prepare(`EXPLAIN QUERY PLAN ${SQLITE_FILL_ACTOR_SQL}`)
      .all(1, 100)
      .map((row) => String((row as { detail: string }).detail))
      .join("\n");
    assert.ok(plan.includes("idx_spine_events_run_terminal (run_id=? AND event_type=?)"), plan);
    // Scanning by connection is O(events of the connection) per run: minutes on a real table.
    assert.ok(!plan.includes("idx_spine_events_instance_seq"), plan);
  });
});

test("backfill: server boot fills historical rows before startup completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-run-actor-boot-"));
  const dbPath = join(dir, "pdpp.sqlite");
  try {
    initDb(dbPath);
    await seedHistoricalRows("sqlite");
    closeDb();
    const server = await startServer({
      asPort: 0,
      dbPath,
      ownerAuthPassword: "run-actor-boot",
      quiet: true,
      rsPort: 0,
    });
    try {
      await server.startupRunHistoryBackfillDone;
      await assertBackfilled("sqlite", "after boot");
    } finally {
      await closeTestServer(server);
      closeDb();
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

type ReportInput = Parameters<typeof projectCollectionReport>[0];
type RunFixture = NonNullable<ReportInput["lastRun"]>;

function run(overrides: Partial<RunFixture>): RunFixture {
  return {
    collection_facts: {
      streams: [
        {
          checkpoint: "committed",
          collected: 0,
          considered: 10,
          covered: 10,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "messages",
        } satisfies RuntimeCollectionFact,
      ],
    },
    event_count: 0,
    failure_reason: null,
    finished_at: "2026-10-01T00:01:00.000Z",
    first_at: "2026-10-01T00:00:00.000Z",
    known_gaps: [],
    last_at: "2026-10-01T00:01:00.000Z",
    recovery_only: false,
    run_id: "run-under-test",
    started_at: "2026-10-01T00:00:00.000Z",
    status: "succeeded",
    terminal_reason: null,
    ...overrides,
  };
}

/** The `messages` stream's coverage condition the Collection Report projects from this one run. */
function conditionFor(candidate: RunFixture): string | undefined {
  return conditionForRuns(candidate, candidate, candidate);
}

function conditionForRuns(
  lastRun: RunFixture,
  lastSuccessfulRun: RunFixture,
  latestSettledRun: RunFixture
): string | undefined {
  const partial: Partial<ReportInput["connectionHealth"]> = {
    axes: { attention: "none", coverage: "unknown", freshness: "fresh", outbox: "idle", remote_surface: "none" },
    conditions: [],
  };
  const entries = projectCollectionReport({
    connectionHealth: partial as ReportInput["connectionHealth"],
    lastRun,
    lastSuccessfulRun,
    latestSettledRun,
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refreshPolicy: null,
  });
  return entries.find((entry) => entry.stream === "messages")?.coverage_condition;
}

backendTest("legacy scheduler skip with NULL run_id keeps earlier runtime coverage after backfill", async (backend) => {
  await emitSpineEvent(startedEvent("run-before-legacy-skip", INSTANCE_A));
  await emitSpineEvent(terminalEvent("run-before-legacy-skip", INSTANCE_A, "runtime"));

  const legacyTable =
    backend === "sqlite"
      ? `CREATE TABLE scheduler_run_history (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           connector_instance_id TEXT NOT NULL,
           connector_id TEXT NOT NULL,
           source_json TEXT NOT NULL,
           status TEXT NOT NULL,
           records_emitted INTEGER NOT NULL DEFAULT 0,
           reported_records_emitted INTEGER,
           checkpoint_summary_json TEXT,
           known_gaps_json TEXT NOT NULL DEFAULT '[]',
           connector_error_json TEXT,
           run_id TEXT,
           trace_id TEXT,
           failure_reason TEXT,
           terminal_reason TEXT,
           started_at TEXT NOT NULL,
           completed_at TEXT NOT NULL,
           error TEXT,
           attempt INTEGER NOT NULL
         )`
      : `CREATE TABLE scheduler_run_history (
           id BIGSERIAL PRIMARY KEY,
           connector_instance_id TEXT NOT NULL,
           connector_id TEXT NOT NULL,
           source_json JSONB NOT NULL,
           status TEXT NOT NULL,
           records_emitted INTEGER NOT NULL DEFAULT 0,
           reported_records_emitted INTEGER,
           checkpoint_summary_json JSONB,
           known_gaps_json JSONB NOT NULL DEFAULT '[]',
           connector_error_json JSONB,
           run_id TEXT,
           trace_id TEXT,
           failure_reason TEXT,
           terminal_reason TEXT,
           started_at TEXT NOT NULL,
           completed_at TEXT NOT NULL,
           error TEXT,
           attempt INTEGER NOT NULL
         )`;
  if (backend === "sqlite") {
    getDb().exec(legacyTable);
    getDb()
      .prepare(
        `INSERT INTO scheduler_run_history(
           connector_instance_id, connector_id, source_json, status, known_gaps_json,
           run_id, started_at, completed_at, attempt
         ) VALUES (?, ?, '{}', 'skipped', '[]', NULL, ?, ?, 1)`
      )
      .run(INSTANCE_A, CONNECTOR_ID, "2026-10-01T00:02:00.000Z", "2026-10-01T00:02:00.000Z");
    closeDb();
    initDb(sqlitePath);
  } else {
    await postgresQuery(legacyTable);
    await postgresQuery(
      `INSERT INTO scheduler_run_history(
         connector_instance_id, connector_id, source_json, status, known_gaps_json,
         run_id, started_at, completed_at, attempt
       ) VALUES ($1, $2, '{}'::jsonb, 'skipped', '[]'::jsonb, NULL, $3, $3, 1)`,
      [INSTANCE_A, CONNECTOR_ID, "2026-10-01T00:02:00.000Z"]
    );
    await bootstrapPostgresSchema();
  }

  const [mergedSkip] = await sql(
    backend,
    "SELECT run_id, status, actor_type, scheduler_managed FROM run_history WHERE status = 'skipped' ORDER BY id DESC LIMIT 1",
    "SELECT run_id, status, actor_type, scheduler_managed FROM run_history WHERE status = 'skipped' ORDER BY id DESC LIMIT 1"
  );
  assert.ok(mergedSkip, "the legacy scheduler skip was merged into run_history");
  assert.equal(mergedSkip.run_id, null, "the legacy skip has no run id");
  assert.equal(mergedSkip.actor_type, null, "the legacy merge leaves actor provenance for the backfill");

  const backfill = await runStartupRunHistoryActorBackfillToCompletion();
  assert.equal(backfill.filled, 1, "the NULL-run_id scheduler row is attributed at the proven boundary");
  const [backfilledSkip] = await sql(
    backend,
    "SELECT run_id, status, actor_type, scheduler_managed FROM run_history WHERE status = 'skipped' ORDER BY id DESC LIMIT 1",
    "SELECT run_id, status, actor_type, scheduler_managed FROM run_history WHERE status = 'skipped' ORDER BY id DESC LIMIT 1"
  );
  const [previousSuccess] = await sql(
    backend,
    "SELECT run_id, status, actor_type, scheduler_managed FROM run_history WHERE run_id = 'run-before-legacy-skip'",
    "SELECT run_id, status, actor_type, scheduler_managed FROM run_history WHERE run_id = 'run-before-legacy-skip'"
  );
  assert.equal(backfilledSkip?.actor_type, "runtime");
  const earlier = run({
    actor_type: previousSuccess?.actor_type as string,
    run_id: String(previousSuccess?.run_id),
    scheduler_managed: Boolean(previousSuccess?.scheduler_managed),
  });
  const latest = run({
    actor_type: backfilledSkip?.actor_type as string | null,
    collection_facts: null,
    run_id: backfilledSkip?.run_id == null ? undefined : String(backfilledSkip.run_id),
    scheduler_managed: Boolean(backfilledSkip?.scheduler_managed),
    status: String(backfilledSkip?.status),
  });
  assert.equal(conditionForRuns(latest, earlier, latest), "complete", "the prior runtime success remains coverage");
});

test("selector: an ordinary server run classifies normally", () => {
  assert.equal(conditionFor(run({ actor_type: "runtime" })), "complete");
});

test("selector: a device run is dropped even with no revision stamp and no marker", () => {
  // A device terminal stored before collection revisions: nothing in its facts marks it.
  const preRevision = run({ actor_type: "local_device" });
  assert.equal(preRevision.collection_revision, undefined);
  assert.equal(preRevision.local_terminal_coverage, undefined);
  assert.equal(conditionFor(preRevision), "unknown");
});

test("selector: a settled run of unknown provenance is dropped, scheduler-managed or not", () => {
  assert.equal(conditionFor(run({ actor_type: null })), "unknown", "unknown provenance fails closed");
  assert.equal(
    conditionFor(run({ actor_type: null, scheduler_managed: false })),
    "unknown",
    "a run no scheduler produced may be a device run"
  );
  // scheduler_managed defaults to TRUE in production, device runs included: it proves nothing.
  assert.equal(
    conditionFor(run({ actor_type: null, scheduler_managed: true })),
    "unknown",
    "scheduler_managed is not evidence of a server run"
  );
});

test("selector: a summary that did not come from run_history carries no provenance to judge", () => {
  assert.equal(run({}).actor_type, undefined);
  assert.equal(conditionFor(run({})), "complete");
});
