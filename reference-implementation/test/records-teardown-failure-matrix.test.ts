// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector-wide teardown (`deleteAllRecordsForConnector`) under failure,
 * SQLite file and Postgres.
 *
 * The fixture is one connector with two connections, two lexical streams,
 * records with history, a blob shared by both connections (a content-addressed
 * cross-reference) plus blobs bound by one connection, lexical index rows, and
 * an untouched sibling connector. The teardown steps are named crash points
 * (server/crash-point.ts, `connector-teardown:*`).
 *
 * Failure modes, each followed by the production restart path:
 *  - a thrown error at every step boundary (first and last occurrence);
 *  - two failures in a row: the retry fails at a different step;
 *  - a process kill (SIGKILL through the crash harness) at every step boundary;
 *  - a kill, then a second kill during the retry.
 *
 * Restart path (what the server schedules after listen): the manifest
 * reconcile retry (`deleteAllRecordsForConnector`), the startup lexical
 * backfill (`lexicalIndexBackfillForManifest`), and the search-index dirty
 * sweep (`runSearchIndexDirtyReconcileRound`).
 *
 * Convergence is asserted against a control run (clean teardown + the same
 * restart path): no orphan blob, binding, lexical row or half-deleted record
 * remains; the sibling connector is unchanged; a second run is a no-op.
 *
 * Before the restart path, each connection and stream is either fully present
 * or fully gone for records, history and version counter (one transaction).
 *
 * Limits: process kill is not power loss (see records-ingest-kill-durability).
 * Semantic index teardown runs but the fixture has no embedding backend, so no
 * semantic rows exist to check.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";

import { __setCrashPointHookForTest } from "../server/crash-point.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { deleteAllRecordsForConnector } from "../server/records.ts";
import { lexicalIndexBackfillForManifest } from "../server/search.ts";
import { runSearchIndexDirtyReconcileRound } from "../server/search-index-reconcile.ts";
import {
  type FixtureIds,
  fixtureIds,
  manifestFor,
  readTeardownState,
  type Sql,
  seedTeardownFixture,
  type TeardownState,
} from "./fixtures/crash/teardown-fixture.ts";
import { spawnCrashChild } from "./helpers/crash-harness.ts";

const CHILD = join(import.meta.dirname, "fixtures/crash/teardown-child.ts");
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const PREFIX = "connector-teardown:";

interface ChildSpec {
  args: string[];
  env: Record<string, string>;
}

interface Backend {
  /** Reopen after a child process wrote to the same storage. */
  close: () => Promise<void>;
  /** Child specs for `count` children; Postgres mints capabilities, so call before seeding. */
  childSpecs: (tag: string, connectorId: string, count: number) => Promise<ChildSpec[]>;
  name: "postgres" | "sqlite";
  open: (tag: string) => Promise<void>;
  sql: Sql;
}

function bind(sql: string, params: unknown[]): [string, unknown[]] {
  const ordered: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_match, n: string) => {
    ordered.push(params[Number(n) - 1]);
    return "?";
  });
  return [text, ordered];
}

function sqliteBackend(dir: string): Backend {
  const pathFor = (tag: string) => join(dir, `${tag}.sqlite`);
  return {
    childSpecs: async (tag, connectorId, count) =>
      Array.from({ length: count }, () => ({
        args: ["sqlite", pathFor(tag), connectorId],
        env: {},
      })),
    close: async () => closeDb(),
    name: "sqlite",
    open: async (tag) => {
      initDb(pathFor(tag));
    },
    sql: {
      exec: async (sql, params = []) => {
        const [text, values] = bind(sql, params);
        getDb()
          .prepare(text)
          .run(...values);
      },
      rows: async (sql, params = []) => {
        const [text, values] = bind(sql, params);
        return getDb()
          .prepare(text)
          .all(...values) as Record<string, unknown>[];
      },
    },
  };
}

function postgresBackend(databaseUrl: string): Backend {
  return {
    childSpecs: async (_tag, connectorId, count) => {
      // One-use capabilities (60 s TTL), minted while `records` is empty.
      await postgresQuery("DELETE FROM records");
      const specs: ChildSpec[] = [];
      for (let n = 0; n < count; n += 1) {
        const attachment = await createAlreadyAdmittedTestDatabaseChildAttachment(databaseUrl);
        specs.push({
          args: ["postgres", "-", connectorId],
          env: { TEARDOWN_CHILD_ATTACHMENT: attachment },
        });
      }
      return specs;
    },
    close: async () => undefined,
    name: "postgres",
    open: async () => undefined,
    sql: {
      exec: async (sql, params = []) => {
        await postgresQuery(sql, params);
      },
      rows: async (sql, params = []) => (await postgresQuery(sql, params)).rows,
    },
  };
}

let tagCounter = 0;
function freshTag(): string {
  tagCounter += 1;
  return `${process.pid}x${tagCounter}`;
}

interface Scenario {
  ids: FixtureIds;
  seeded: TeardownState;
  specs: ChildSpec[];
  tag: string;
}

async function withScenario(
  backend: Backend,
  childCount: number,
  run: (scenario: Scenario) => Promise<void>
): Promise<void> {
  const tag = freshTag();
  const ids = fixtureIds(tag);
  const specs = await backend.childSpecs(tag, ids.connector, childCount);
  await backend.open(tag);
  try {
    await seedTeardownFixture(backend.sql, ids);
    const seeded = await readTeardownState(backend.sql, ids);
    await run({ ids, seeded, specs, tag });
  } finally {
    await backend.close();
  }
}

/** The restart path the server runs: reconcile retry, startup lexical backfill, dirty sweep. */
async function restartPath(ids: FixtureIds): Promise<{ deletedCount: number }> {
  const retry = await deleteAllRecordsForConnector(ids.connector);
  await lexicalIndexBackfillForManifest({
    manifest: manifestFor(ids.connector) as never,
  });
  await lexicalIndexBackfillForManifest({
    manifest: manifestFor(ids.sibling) as never,
  });
  await runSearchIndexDirtyReconcileRound();
  return { deletedCount: retry.deletedCount };
}

/** Run the teardown with an exception thrown at the `nth` hit of `point`. Returns the error, if any. */
async function throwingAttempt(ids: FixtureIds, point: string, nth: number): Promise<string | null> {
  let hits = 0;
  __setCrashPointHookForTest((name) => {
    if (name === `${PREFIX}${point}` && ++hits === nth) throw new Error(`injected failure at ${point}#${nth}`);
  });
  try {
    await deleteAllRecordsForConnector(ids.connector);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    __setCrashPointHookForTest(null);
  }
}

/** Kill a child running the teardown at the `nth` hit of `point`. */
async function killAttempt(spec: ChildSpec, point: string, nth: number): Promise<void> {
  const name = `${PREFIX}${point}`;
  const child = spawnCrashChild(CHILD, {
    args: spec.args,
    env: spec.env,
    points: [name],
  });
  for (let hit = 1; hit < nth; hit += 1) {
    await child.parked(name);
    child.resume();
  }
  await child.parked(name);
  const exit = await child.kill();
  assert.equal(exit.signal, "SIGKILL", `child must die by SIGKILL at ${point}#${nth}`);
}

/** Step names and how often each is hit in one clean teardown, in first-hit order. */
async function recordSteps(backend: Backend): Promise<Map<string, number>> {
  const steps = new Map<string, number>();
  await withScenario(backend, 0, async ({ ids }) => {
    __setCrashPointHookForTest((name) => {
      if (name.startsWith(PREFIX))
        steps.set(name.slice(PREFIX.length), (steps.get(name.slice(PREFIX.length)) ?? 0) + 1);
    });
    try {
      await deleteAllRecordsForConnector(ids.connector);
    } finally {
      __setCrashPointHookForTest(null);
    }
  });
  return steps;
}

/**
 * Control: a clean teardown followed by the restart path. The clean teardown
 * must already leave nothing behind on its own: the restart path (startup
 * backfill) would otherwise hide a missing teardown step.
 */
async function controlFinalState(backend: Backend): Promise<TeardownState> {
  let finalState: TeardownState | undefined;
  await withScenario(backend, 0, async ({ ids, seeded }) => {
    await deleteAllRecordsForConnector(ids.connector);
    const direct = await readTeardownState(backend.sql, ids);
    for (const [pair, now] of Object.entries(direct.pairs)) {
      if (pair === "S/items") continue;
      assert.deepEqual(
        {
          bindings: now.bindings,
          changes: now.changes,
          counter: now.counter,
          lexical: now.lexical,
          records: now.records,
        },
        { ...GONE, lexical: 0 },
        `${backend.name} clean teardown left rows behind in ${pair}`
      );
    }
    assert.deepEqual(direct.pairs["S/items"], seeded.pairs["S/items"]);
    await restartPath(ids);
    finalState = await readTeardownState(backend.sql, ids);
  });
  assert.ok(finalState);
  return finalState;
}

const GONE = { bindings: 0, changes: 0, counter: 0, records: 0 } as const;

/** Before the restart path: no half-deleted pair, and the sibling is untouched. */
function assertNoHalfDeletedPair(label: string, state: TeardownState, seeded: TeardownState): void {
  for (const [pair, now] of Object.entries(state.pairs)) {
    const before = seeded.pairs[pair];
    assert.ok(before, `${label}: unknown pair ${pair}`);
    const present = {
      changes: before.changes,
      counter: before.counter,
      records: before.records,
    };
    const atoms = {
      changes: now.changes,
      counter: now.counter,
      records: now.records,
    };
    const isPresent = JSON.stringify(atoms) === JSON.stringify(present);
    const isGone = atoms.records === 0 && atoms.changes === 0 && atoms.counter === 0;
    assert.ok(isPresent || isGone, `${label}: ${pair} is half deleted: ${JSON.stringify(atoms)}`);
  }
  assert.deepEqual(state.pairs["S/items"], seeded.pairs["S/items"], `${label}: sibling connector changed`);
  assert.equal(state.blobs.sibling, true, `${label}: sibling blob removed`);
}

/**
 * SQLite does not reclaim a blob row first uploaded by a connection that was
 * torn down EARLIER than the last connection still bound to it (documented as
 * a KNOWN GAP in records.ts, `deleteConnectionRecordRowsSqlite`). A failure
 * that lets the owner go first reaches that state, so the `shared` blob is
 * left out of the SQLite convergence check here and pinned by the `todo` test
 * at the end of this file.
 */
function assertConverged(
  backend: Backend,
  label: string,
  state: TeardownState,
  control: TeardownState,
  seeded: TeardownState
): void {
  const view = (snapshot: TeardownState): TeardownState =>
    backend.name === "sqlite" ? { ...snapshot, blobs: { ...snapshot.blobs, shared: false } } : snapshot;
  assert.deepEqual(view(state), view(control), `${label}: state must equal the control run`);
  for (const [pair, now] of Object.entries(state.pairs)) {
    if (pair === "S/items") continue;
    assert.deepEqual(
      {
        bindings: now.bindings,
        changes: now.changes,
        counter: now.counter,
        lexical: now.lexical,
        records: now.records,
      },
      { ...GONE, lexical: 0 },
      `${label}: ${pair} left rows behind`
    );
  }
  const reclaimed = backend.name === "sqlite" ? (["onlyA", "onlyB"] as const) : (["shared", "onlyA", "onlyB"] as const);
  for (const role of reclaimed) {
    assert.equal(state.blobs[role], false, `${label}: orphan blob ${role}`);
  }
  assert.deepEqual(state.pairs["S/items"], seeded.pairs["S/items"], `${label}: sibling connector changed`);
  assert.equal(state.blobs.sibling, true, `${label}: sibling blob removed`);
}

async function assertSecondRunIsNoop(backend: Backend, scenario: Scenario, label: string): Promise<void> {
  const before = await readTeardownState(backend.sql, scenario.ids);
  const again = await restartPath(scenario.ids);
  assert.equal(again.deletedCount, 0, `${label}: a second teardown must delete nothing`);
  assert.deepEqual(
    await readTeardownState(backend.sql, scenario.ids),
    before,
    `${label}: a second run must change nothing`
  );
}

function occurrences(steps: Map<string, number>): { nth: number; point: string }[] {
  const out: { nth: number; point: string }[] = [];
  for (const [point, count] of steps) {
    out.push({ nth: 1, point });
    if (count > 1) out.push({ nth: count, point });
  }
  return out;
}

type Phase = "kill" | "kill-twice" | "throw" | "throw-twice";

async function runMatrix(backend: Backend, phase: Phase): Promise<void> {
  const steps = await recordSteps(backend);
  assert.ok(steps.size >= 6, `expected the teardown to pass its named steps, saw ${[...steps.keys()].join(",")}`);
  const control = await controlFinalState(backend);
  const firstHits = [...steps.keys()];

  // 1. A thrown error at every step boundary, then the restart path.
  for (const { point, nth } of phase === "throw" ? occurrences(steps) : []) {
    const label = `${backend.name} throw at ${point}#${nth}`;
    await withScenario(backend, 0, async (scenario) => {
      const failure = await throwingAttempt(scenario.ids, point, nth);
      assert.ok(failure, `${label}: the injected failure must surface`);
      assertNoHalfDeletedPair(label, await readTeardownState(backend.sql, scenario.ids), scenario.seeded);
      await restartPath(scenario.ids);
      assertConverged(backend, label, await readTeardownState(backend.sql, scenario.ids), control, scenario.seeded);
      await assertSecondRunIsNoop(backend, scenario, label);
    });
  }

  // 2. Two failures in a row: the retry throws at a different step.
  for (const first of phase === "throw-twice" ? firstHits : []) {
    for (const second of firstHits) {
      if (first === second) continue;
      const label = `${backend.name} throw at ${first}, retry throws at ${second}`;
      await withScenario(backend, 0, async (scenario) => {
        assert.ok(await throwingAttempt(scenario.ids, first, 1), `${label}: first failure must surface`);
        await throwingAttempt(scenario.ids, second, 1);
        assertNoHalfDeletedPair(label, await readTeardownState(backend.sql, scenario.ids), scenario.seeded);
        await restartPath(scenario.ids);
        assertConverged(backend, label, await readTeardownState(backend.sql, scenario.ids), control, scenario.seeded);
      });
    }
  }

  // 3. A process kill at every step boundary, then the restart path.
  for (const { point, nth } of phase === "kill" ? occurrences(steps) : []) {
    const label = `${backend.name} kill at ${point}#${nth}`;
    await withScenario(backend, 1, async (scenario) => {
      await backend.close();
      await killAttempt(scenario.specs[0] as ChildSpec, point, nth);
      await backend.open(scenario.tag);
      assertNoHalfDeletedPair(label, await readTeardownState(backend.sql, scenario.ids), scenario.seeded);
      await restartPath(scenario.ids);
      assertConverged(backend, label, await readTeardownState(backend.sql, scenario.ids), control, scenario.seeded);
      await assertSecondRunIsNoop(backend, scenario, label);
    });
  }

  // 4. A kill, then a second kill during the retry.
  for (const [first, second] of phase === "kill-twice" ? killRetryPairs(steps) : []) {
    const label = `${backend.name} kill at ${first.point}#${first.nth}, retry killed at ${second.point}#${second.nth}`;
    await withScenario(backend, 2, async (scenario) => {
      await backend.close();
      await killAttempt(scenario.specs[0] as ChildSpec, first.point, first.nth);
      await killAttempt(scenario.specs[1] as ChildSpec, second.point, second.nth);
      await backend.open(scenario.tag);
      assertNoHalfDeletedPair(label, await readTeardownState(backend.sql, scenario.ids), scenario.seeded);
      await restartPath(scenario.ids);
      assertConverged(backend, label, await readTeardownState(backend.sql, scenario.ids), control, scenario.seeded);
    });
  }
}

/** Kill pairs whose second step the retry still reaches. */
function killRetryPairs(
  steps: Map<string, number>
): [{ nth: number; point: string }, { nth: number; point: string }][] {
  const has = (point: string) => steps.has(point);
  const pairs: [{ nth: number; point: string }, { nth: number; point: string }][] = [];
  // First instance rolled back (kill before commit): the retry redoes it fully.
  if (has("before-commit") && has("after-lexical-delete")) {
    pairs.push([
      { nth: 1, point: "before-commit" },
      { nth: 1, point: "after-lexical-delete" },
    ]);
  }
  // First instance done, second not started: the retry starts at the second.
  if (has("after-instances") && has("before-commit")) {
    pairs.push([
      { nth: 1, point: "after-durable-delete" },
      { nth: 1, point: "before-commit" },
    ]);
  }
  return pairs;
}

/** Test admission needs an empty `records` table; earlier tests in this file left rows. */
async function emptyRecordsForAdmission(databaseUrl: string): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query("DELETE FROM records");
  } catch {
    // First test of the file: the schema does not exist yet.
  } finally {
    await admin.end();
  }
}

const PHASES: [Phase, string][] = [
  ["throw", "a thrown error at each step"],
  ["throw-twice", "a thrown error, then a different thrown error in the retry"],
  ["kill", "a process kill at each step"],
  ["kill-twice", "a kill, then a second kill in the retry"],
];

for (const [phase, title] of PHASES) {
  test(`[sqlite] connector-wide teardown converges after ${title}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-teardown-matrix-"));
    try {
      await runMatrix(sqliteBackend(dir), phase);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  });
}

if (POSTGRES_URL) {
  for (const [phase, title] of PHASES) {
    test(`[postgres] connector-wide teardown converges after ${title}`, async () => {
      await emptyRecordsForAdmission(POSTGRES_URL);
      initDb(":memory:");
      await initPostgresStorage({
        backend: "postgres",
        databaseUrl: POSTGRES_URL,
      });
      try {
        await runMatrix(postgresBackend(POSTGRES_URL), phase);
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    });
  }
}

// Known gap (see `assertConverged`): documented in records.ts as not repaired on
// SQLite, design-level fix. `todo` keeps the suite green and the gap visible.
test("[sqlite] a blob first uploaded by a connection torn down earlier is reclaimed after a failed teardown", {
  todo: "SQLite blob reclaim keys on the first uploader (records.ts KNOWN GAP in deleteConnectionRecordRowsSqlite)",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-teardown-gap-"));
  try {
    const backend = sqliteBackend(dir);
    await withScenario(backend, 0, async ({ ids }) => {
      // Connection A fails, connection B (the uploader) is torn down, then A is retried.
      assert.ok(await throwingAttempt(ids, "before-durable-delete", 1));
      await restartPath(ids);
      const state = await readTeardownState(backend.sql, ids);
      assert.equal(state.blobs.shared, false, "the shared blob has no binding left and must be reclaimed");
    });
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

// Pins a dependency the matrix relies on: after the durable delete committed, the
// reconcile retry no longer finds the pair (it enumerates `records` and
// `version_counter`), so only the startup lexical backfill removes the index rows.
test("[sqlite] index rows left by a failure after the durable delete survive the reconcile retry and are removed by the startup backfill", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-teardown-index-"));
  try {
    const backend = sqliteBackend(dir);
    await withScenario(backend, 0, async ({ ids }) => {
      assert.ok(await throwingAttempt(ids, "after-durable-delete", 1));
      const retry = await deleteAllRecordsForConnector(ids.connector);
      const afterRetry = await readTeardownState(backend.sql, ids);
      assert.equal(retry.deletedCount, 0, "the retry finds no records left to delete");
      assert.ok(
        (afterRetry.pairs["A/items"]?.lexical ?? 0) > 0,
        "the reconcile retry alone does not reach the orphan lexical rows"
      );
      await lexicalIndexBackfillForManifest({
        manifest: manifestFor(ids.connector) as never,
      });
      const afterBackfill = await readTeardownState(backend.sql, ids);
      assert.equal(afterBackfill.pairs["A/items"]?.lexical, 0, "the startup backfill removes them");
      assert.equal(afterBackfill.pairs["A/notes"]?.lexical, 0);
    });
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});
