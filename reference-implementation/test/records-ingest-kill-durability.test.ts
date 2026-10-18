// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ingest durability across a process kill, SQLite file and Postgres.
 *
 * A child process runs one real ingest against the production store and is
 * SIGKILLed at a named boundary of the durable unit. The parent then reopens
 * the same storage and asserts the unit is all-or-nothing:
 *
 *  - kill before the commit (after the version allocation, after the record and
 *    history writes, after the dirty mark, just before COMMIT): the state is
 *    identical to the state before the write (record, history, version counter,
 *    search-index dirty revision, retained-size projection);
 *  - kill after the commit and before the ack: the state is identical to a
 *    control run of the same write that was not killed;
 *  - a batch killed after its first record's commit holds exactly that record
 *    (each record is its own durable unit; the batch is not one transaction);
 *  - the next ingest after the restart takes the next unused version, and a
 *    retry of the killed write converges on the control state (no version is
 *    reused or skipped).
 *
 * Limit: SIGKILL loses process memory but not the kernel page cache. This
 * proves recovery from a process crash. It does NOT prove power-loss
 * durability. What a power loss would depend on: SQLite runs with
 * `journal_mode = WAL` and `synchronous = NORMAL` (server/db.ts, `initDb`), so
 * the last committed transactions may be lost on power failure but the file
 * stays consistent; Postgres uses its server defaults (no override found in
 * server/postgres-storage.ts).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { ingestRecord, ingestRecords } from "../server/records.ts";
import { reconcileDirtyRetainedSize } from "../server/retained-size-read-model.ts";
import { killChildAt, runCrashChild } from "./helpers/crash-harness.ts";

const CHILD = join(import.meta.dirname, "fixtures/crash/ingest-kill-child.ts");
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const STREAM = "items";
const EMITTED_AT = "2026-10-18T00:00:00.000Z";

type Scenario = "batch" | "delete" | "upsert";
interface Row {
  deleted: boolean;
  json: unknown;
  key: string;
  version: number;
}
interface Snapshot {
  changes: Row[];
  counter: number | null;
  dirtyRevision: number | null;
  records: Row[];
  retained: {
    currentBytes: number;
    historyCount: number;
    recordCount: number;
  } | null;
}

interface Backend {
  close: () => Promise<void>;
  /** Child args + env for a child that attaches to this store. */
  child: (connectorId: string, scenario: Scenario) => Promise<{ args: string[]; env: Record<string, string> }>;
  name: "postgres" | "sqlite";
  open: () => Promise<void>;
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
}

let counter = 0;
function freshConnectorId(): string {
  counter += 1;
  return `https://test.pdpp.dev/connectors/ingest-kill-${process.pid}-${counter}`;
}

const upsert = (key: string, v: number) => ({
  data: { id: key, v },
  emitted_at: EMITTED_AT,
  key,
  op: "upsert" as const,
  stream: STREAM,
});

async function seed(connectorId: string): Promise<void> {
  await ingestRecord(connectorId, upsert("a", 1), { deferIndexes: true });
  await ingestRecord(connectorId, upsert("b", 1), { deferIndexes: true });
}

/** The same write the child performs, run in-process: what a connector retry does. */
async function replay(connectorId: string, scenario: Scenario): Promise<void> {
  if (scenario === "upsert") {
    await ingestRecord(connectorId, upsert("a", 2), { deferIndexes: true });
  } else if (scenario === "delete") {
    await ingestRecord(
      connectorId,
      {
        data: { id: "a" },
        emitted_at: EMITTED_AT,
        key: "a",
        op: "delete",
        stream: STREAM,
      },
      { deferIndexes: true }
    );
  } else {
    await ingestRecords(connectorId, [upsert("a", 2), upsert("b", 2)]);
  }
}

async function snapshot(backend: Backend, connectorId: string): Promise<Snapshot> {
  const rowsOf = async (table: "record_changes" | "records", order: string) =>
    (
      await backend.query(
        `SELECT record_key, version, record_json, deleted FROM ${table} WHERE connector_id = $1 AND stream = $2 ORDER BY ${order}`,
        [connectorId, STREAM]
      )
    ).map((row) => ({
      deleted: Boolean(row.deleted),
      json: typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json,
      key: String(row.record_key),
      version: Number(row.version),
    }));
  const one = async (sql: string) => (await backend.query(sql, [connectorId, STREAM]))[0];
  const counterRow = await one("SELECT max_version FROM version_counter WHERE connector_id = $1 AND stream = $2");
  const dirtyRow = await one("SELECT revision FROM search_index_dirty WHERE connector_id = $1 AND stream = $2");
  const retainedRow = await one(
    "SELECT record_count, record_history_count, current_record_json_bytes FROM retained_size_stream WHERE connector_id = $1 AND stream = $2"
  );
  return {
    changes: await rowsOf("record_changes", "version, record_key"),
    counter: counterRow ? Number(counterRow.max_version) : null,
    dirtyRevision: dirtyRow ? Number(dirtyRow.revision) : null,
    records: await rowsOf("records", "record_key"),
    retained: retainedRow
      ? {
          currentBytes: Number(retainedRow.current_record_json_bytes),
          historyCount: Number(retainedRow.record_history_count),
          recordCount: Number(retainedRow.record_count),
        }
      : null,
  };
}

/**
 * Postgres applies the retained-size delta AFTER the ingest commit, in a
 * separate transaction (records.ts `ingestPostgresRecord`). A kill in between
 * leaves that projection stale with no dirty mark and nothing repairs it, so
 * the matrix does not compare it there. The gap is pinned by the `todo` test
 * below. SQLite applies the delta inside the ingest transaction.
 */
function isRetainedSizeCommitGap(backend: Backend, point: string): boolean {
  return backend.name === "postgres" && point === "ingest:after-commit-before-ack";
}

const withoutRetained = (snap: Snapshot | undefined): Snapshot | undefined => snap && { ...snap, retained: null };

/** Invariants that must hold in every reopened state, killed or not. */
function assertConsistent(snap: Snapshot, label: string, checkRetained = true): void {
  const versions = snap.changes.map((row) => row.version);
  assert.equal(new Set(versions).size, versions.length, `${label}: duplicate history versions ${versions.join(",")}`);
  assert.equal(
    snap.counter,
    Math.max(0, ...versions),
    `${label}: version_counter must equal the newest history version`
  );
  for (const record of snap.records) {
    const latest = snap.changes
      .filter((row) => row.key === record.key)
      .reduce((a, b) => (b.version > a.version ? b : a));
    assert.deepEqual(record, latest, `${label}: current row ${record.key} must equal its newest history row`);
  }
  if (snap.retained && checkRetained) {
    assert.equal(
      snap.retained.recordCount,
      snap.records.filter((row) => !row.deleted).length,
      `${label}: retained-size record_count`
    );
    assert.equal(snap.retained.historyCount, snap.changes.length, `${label}: retained-size record_history_count`);
  }
}

function sqliteBackend(dir: string): Backend {
  const sqlitePath = join(dir, "pdpp.sqlite");
  return {
    child: async (connectorId, scenario) => ({
      args: ["sqlite", sqlitePath, connectorId, scenario],
      env: {},
    }),
    close: async () => closeDb(),
    name: "sqlite",
    open: async () => {
      initDb(sqlitePath);
    },
    query: async (sql, params) =>
      getDb()
        .prepare(sql.replace(/\$\d+/g, "?"))
        .all(...params) as Record<string, unknown>[],
  };
}

function postgresBackend(databaseUrl: string): Backend {
  return {
    child: async (connectorId, scenario) => {
      // One-use capability, minted while `records` is empty (60 s TTL).
      await postgresQuery("DELETE FROM records");
      const attachment = await createAlreadyAdmittedTestDatabaseChildAttachment(databaseUrl);
      return {
        args: ["postgres", "-", connectorId, scenario],
        env: { KILL_CHILD_ATTACHMENT: attachment },
      };
    },
    close: async () => undefined,
    name: "postgres",
    open: async () => undefined,
    query: async (sql, params) => (await postgresQuery(sql, params)).rows,
  };
}

const KILLS: {
  expect: "absent" | "full" | "partial";
  point: string;
  scenario: Scenario;
}[] = [
  {
    expect: "absent",
    point: "ingest:after-version-allocation",
    scenario: "upsert",
  },
  { expect: "absent", point: "ingest:after-record-write", scenario: "upsert" },
  { expect: "absent", point: "ingest:after-dirty-mark", scenario: "upsert" },
  { expect: "absent", point: "ingest:before-commit", scenario: "upsert" },
  {
    expect: "full",
    point: "ingest:after-commit-before-ack",
    scenario: "upsert",
  },
  { expect: "absent", point: "ingest:before-commit", scenario: "delete" },
  {
    expect: "full",
    point: "ingest:after-commit-before-ack",
    scenario: "delete",
  },
  {
    expect: "partial",
    point: "ingest:after-commit-before-ack",
    scenario: "batch",
  },
];

/** Run `scenario` to completion in a child, no kill: the oracle for "committed". */
async function controlSnapshot(backend: Backend, scenario: Scenario): Promise<Snapshot> {
  const connectorId = freshConnectorId();
  const { args, env } = await backend.child(connectorId, scenario);
  await backend.open();
  await seed(connectorId);
  await backend.close();
  await runCrashChild(CHILD, { args, env });
  await backend.open();
  const snap = await snapshot(backend, connectorId);
  assertConsistent(snap, `${backend.name} control ${scenario}`);
  await backend.close();
  return snap;
}

async function runKillMatrix(backend: Backend): Promise<void> {
  const controls = new Map<Scenario, Snapshot>();
  for (const scenario of ["upsert", "delete", "batch"] as const) {
    controls.set(scenario, await controlSnapshot(backend, scenario));
  }
  for (const kill of KILLS) {
    const label = `${backend.name} ${kill.scenario} killed at ${kill.point}`;
    const connectorId = freshConnectorId();
    // Mint the child's capability first: it needs an empty `records` table.
    const { args, env } = await backend.child(connectorId, kill.scenario);
    await backend.open();
    await seed(connectorId);
    const before = await snapshot(backend, connectorId);
    await backend.close();

    await killChildAt(CHILD, kill.point, { args, env });

    await backend.open();
    const gap = isRetainedSizeCommitGap(backend, kill.point);
    const strip = (snap: Snapshot | undefined) => (gap ? withoutRetained(snap) : snap);
    const after = await snapshot(backend, connectorId);
    assertConsistent(after, label, !gap);
    const expected =
      kill.expect === "absent" ? before : controls.get(kill.expect === "partial" ? "upsert" : kill.scenario);
    assert.deepEqual(strip(after), strip(expected), `${label}: reopened state must be ${kill.expect}`);
    if (backend.name === "sqlite") {
      assert.deepEqual(await backend.query("PRAGMA integrity_check", []), [{ integrity_check: "ok" }], label);
    }

    // A retry of the killed write converges on the control state: the
    // committed part is a no-op, the lost part is applied once.
    await replay(connectorId, kill.scenario);
    const retried = await snapshot(backend, connectorId);
    assertConsistent(retried, `${label} + retry`, !gap);
    assert.deepEqual(
      strip(retried),
      strip(controls.get(kill.scenario)),
      `${label}: retry must converge on the control state`
    );

    // The next ingest after the restart takes the next unused version.
    const maxBefore = Math.max(...retried.changes.map((row) => row.version));
    await ingestRecord(connectorId, upsert("c", 1), { deferIndexes: true });
    const next = await snapshot(backend, connectorId);
    assertConsistent(next, `${label} + next ingest`, !gap);
    assert.equal(
      next.changes.find((row) => row.key === "c")?.version,
      maxBefore + 1,
      `${label}: next ingest must take version ${maxBefore + 1}`
    );
    await backend.close();
  }
}

test("[sqlite] ingest killed at each durable boundary is all-or-nothing and resumes with the next version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-ingest-kill-"));
  try {
    await runKillMatrix(sqliteBackend(dir));
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

if (POSTGRES_URL) {
  test("[postgres] ingest killed at each durable boundary is all-or-nothing and resumes with the next version", async () => {
    initDb(":memory:");
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: POSTGRES_URL,
    });
    try {
      await runKillMatrix(postgresBackend(POSTGRES_URL));
    } finally {
      await closePostgresStorage();
      closeDb();
    }
  });
}

if (POSTGRES_URL) {
  // Real defect, design-level fix (see the PR body). `todo` keeps the suite green
  // while the gap stays visible; when the delta becomes crash-safe this passes.
  test("[postgres] retained-size projection is repaired after a kill between the ingest commit and its delta", {
    todo: "Postgres applies the retained-size delta after commit; a kill there leaves it stale and undetected",
  }, async () => {
    // The matrix test above left rows behind; admission needs `records` empty.
    const admin = new Client({ connectionString: POSTGRES_URL });
    await admin.connect();
    await admin.query("DELETE FROM records");
    await admin.end();
    initDb(":memory:");
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: POSTGRES_URL,
    });
    try {
      const backend = postgresBackend(POSTGRES_URL);
      const connectorId = freshConnectorId();
      const { args, env } = await backend.child(connectorId, "upsert");
      await seed(connectorId);
      await killChildAt(CHILD, "ingest:after-commit-before-ack", { args, env });
      // The recovery production runs: read-time reconcile of dirty rows.
      await reconcileDirtyRetainedSize();
      assertConsistent(await snapshot(backend, connectorId), "postgres after commit-gap kill + reconcile");
    } finally {
      await closePostgresStorage();
      closeDb();
    }
  });
}
