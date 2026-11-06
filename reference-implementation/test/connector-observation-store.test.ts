// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector observation run store (Collection Profile v0.2.0, data-connectors
 * spec sections 5.10.3 and 5.10.4) on both backends.
 *
 * Fixtures come from the typed runtime (`createObservationRun`), so retired
 * facts and runtime defects are produced by the same code that the runtime
 * uses, not hand-built. The Postgres cases skip unless PDPP_TEST_POSTGRES_URL
 * is set, as in checkpoint-withhold-store.test.ts.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createObservationRun,
  type Diagnosis,
  type ObservationSnapshot,
  validateDiagnosticDescriptors,
} from "../runtime/observations.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  CONNECTOR_OBSERVATION_RECORD_MAX_BYTES,
  CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR,
  type ConnectorObservationRunInput,
  type ConnectorObservationRunStore,
  ConnectorObservationStoreError,
  getDefaultConnectorObservationStore,
  resetDefaultConnectorObservationStoreCache,
} from "../server/stores/connector-observation-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-11-02T00:00:00.000Z";
const CAP = CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR;
const PRUNE_FAULT = /seeded prune fault/;
const INSERT_FAULT = /seeded insert fault/;

type FaultKind = "prune" | "insert";

/** One storage engine under test. Both implementations expose the same seams. */
interface Harness {
  deleteConnection: (connectorInstanceId: string) => Promise<void>;
  installFault: (kind: FaultKind) => Promise<void>;
  removeFault: (kind: FaultKind) => Promise<void>;
  reopen: () => Promise<void>;
  retainedSequences: (connectorId: string) => Promise<number[]>;
  rowCount: (connectorId: string) => Promise<number>;
  seedConnection: (connectorId: string, connectorInstanceId: string) => Promise<void>;
}

function uniq(tag: string): string {
  return `${tag}-${randomUUID()}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Runs a synchronous SQLite step; a throw becomes a rejection, as the async Postgres seam does. */
function settle<T>(step: () => T): Promise<T> {
  try {
    return Promise.resolve(step());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Runs `step` for each item one at a time, in list order. Store sequence numbers
 * follow call order, so the writes must not interleave. A plain `await` loop is
 * flagged by noAwaitInLoops, and Promise.all would interleave them.
 */
function inOrder<T>(items: readonly T[], step: (item: T) => Promise<unknown>): Promise<void> {
  return items
    .reduce<Promise<unknown>>((done, item) => done.then(() => step(item)), Promise.resolve())
    .then(() => undefined);
}

/** Runtime-built snapshot: one retired fact, one auth failure, one runtime defect. */
function observedRun(tag: string): {
  snapshot: ObservationSnapshot;
  diagnosis: Diagnosis;
} {
  const run = createObservationRun({
    declared: true,
    descriptors: validateDiagnosticDescriptors({
      expectations: [{ id: "login_button", step: "login" }],
      rules: [{ id: "bad_password", kind: "auth", step: "login" }],
      steps: [{ id: "login" }],
    }),
  });
  const expect = run.accept({
    attrs: {
      expectation: "login_button",
      final: "absent",
      states_seen: ["absent"],
    },
    fact: "element_expectation",
    id: `${tag}-expect`,
    step: "login",
    type: "OBSERVATION",
  });
  const auth = run.accept({
    attrs: { kind: "auth_failure", rule: "bad_password" },
    fact: "provider_message",
    id: `${tag}-auth`,
    step: "login",
    type: "OBSERVATION",
  });
  const retry = run.accept({
    attrs: {
      expectation: "login_button",
      final: "matched",
      states_seen: ["absent", "matched"],
    },
    fact: "element_expectation",
    id: `${tag}-retry`,
    resolves: [`${tag}-expect`],
    step: "login",
    type: "OBSERVATION",
  });
  // A runtime fact type from a connector is discarded and recorded as a defect.
  run.accept({ fact: "rule_match", id: `${tag}-forged`, type: "OBSERVATION" });
  for (const outcome of [expect, auth, retry]) {
    assert.equal(outcome.status, "accepted", "runtime fixture fact must be accepted");
  }
  return {
    diagnosis: run.diagnose([`${tag}-auth`, `${tag}-expect`]),
    snapshot: {
      ...run.snapshot(),
      connector_suggestions: [{ action: "refresh_credentials", attribution: "connector", origin: "done_error" }],
    },
  };
}

function runInput(connectorId: string, connectorInstanceId: string, runId: string): ConnectorObservationRunInput {
  return { connectorId, connectorInstanceId, runId, ...observedRun(runId) };
}

function storeOf(): ConnectorObservationRunStore {
  return getDefaultConnectorObservationStore();
}

async function expectStoreError(promise: Promise<unknown>, code: string, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectorObservationStoreError, `${message}: expected ConnectorObservationStoreError`);
    assert.equal(error.code, code, message);
    return true;
  });
}

function faultSql(kind: FaultKind, action: "install" | "remove"): string[] {
  const label = kind === "prune" ? "seeded prune fault" : "seeded insert fault";
  const event = kind === "prune" ? "DELETE" : "INSERT";
  const name = `observation_${kind}_fault`;
  if (action === "remove") {
    return [`DROP TRIGGER IF EXISTS ${name}`];
  }
  return [
    `CREATE TRIGGER ${name} BEFORE ${event} ON connector_observation_runs BEGIN SELECT RAISE(ABORT, '${label}'); END`,
  ];
}

function sqliteHarness(path: string): Harness {
  return {
    deleteConnection: (connectorInstanceId) =>
      settle(() => {
        getDb().prepare("DELETE FROM connector_instances WHERE connector_instance_id = ?").run(connectorInstanceId);
      }),
    installFault: (kind) =>
      settle(() => {
        for (const sql of faultSql(kind, "install")) {
          getDb().exec(sql);
        }
      }),
    removeFault: (kind) =>
      settle(() => {
        for (const sql of faultSql(kind, "remove")) {
          getDb().exec(sql);
        }
      }),
    reopen: () =>
      settle(() => {
        closeDb();
        initDb(path);
        resetDefaultConnectorObservationStoreCache();
      }),
    retainedSequences: (connectorId) =>
      settle(() => {
        const rows = getDb()
          .prepare(
            "SELECT recorded_seq AS seq FROM connector_observation_runs WHERE connector_id = ? ORDER BY recorded_seq"
          )
          .all(connectorId) as { seq: number }[];
        return rows.map((row) => Number(row.seq));
      }),
    rowCount: (connectorId) =>
      settle(() => {
        const row = getDb()
          .prepare("SELECT COUNT(*) AS n FROM connector_observation_runs WHERE connector_id = ?")
          .get(connectorId) as { n: number };
        return row.n;
      }),
    seedConnection: (connectorId, connectorInstanceId) =>
      settle(() => {
        getDb()
          .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)")
          .run(connectorId, NOW);
        getDb()
          .prepare(
            `INSERT OR IGNORE INTO connector_instances(
             connector_instance_id, owner_subject_id, connector_id, display_name, status,
             source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
           ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
          )
          .run(connectorInstanceId, connectorId, connectorInstanceId, NOW, NOW);
      }),
  };
}

function postgresHarness(databaseUrl: string): Harness {
  return {
    async deleteConnection(connectorInstanceId) {
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
    },
    async installFault(kind) {
      const label = kind === "prune" ? "seeded prune fault" : "seeded insert fault";
      const event = kind === "prune" ? "DELETE" : "INSERT";
      const fn = `observation_${kind}_fault_fn`;
      await postgresQuery(
        `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${label}'; END $$`
      );
      await postgresQuery(
        `CREATE TRIGGER observation_${kind}_fault BEFORE ${event} ON connector_observation_runs FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`
      );
    },
    async removeFault(kind) {
      await postgresQuery(`DROP TRIGGER IF EXISTS observation_${kind}_fault ON connector_observation_runs`);
      await postgresQuery(`DROP FUNCTION IF EXISTS observation_${kind}_fault_fn()`);
    },
    async reopen() {
      await closePostgresStorage();
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      resetDefaultConnectorObservationStoreCache();
    },
    async retainedSequences(connectorId) {
      const result = await postgresQuery<{ seq: string | number }>(
        "SELECT recorded_seq AS seq FROM connector_observation_runs WHERE connector_id = $1 ORDER BY recorded_seq",
        [connectorId]
      );
      return result.rows.map((row) => Number(row.seq));
    },
    async rowCount(connectorId) {
      const result = await postgresQuery<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM connector_observation_runs WHERE connector_id = $1",
        [connectorId]
      );
      return result.rows[0]?.n ?? 0;
    },
    async seedConnection(connectorId, connectorInstanceId) {
      await postgresQuery(
        "INSERT INTO connectors(connector_id, manifest) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING",
        [connectorId, "{}"]
      );
      await postgresQuery(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES ($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)
         ON CONFLICT DO NOTHING`,
        [connectorInstanceId, connectorId, NOW]
      );
    },
  };
}

async function withSqlite(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-observation-store-"));
  const path = join(dir, "pdpp.sqlite");
  resetDefaultConnectorObservationStoreCache();
  initDb(path);
  try {
    await fn(sqliteHarness(path));
  } finally {
    closeDb();
    resetDefaultConnectorObservationStoreCache();
    rmSync(dir, { force: true, recursive: true });
  }
}

async function withPostgres(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const databaseUrl = POSTGRES_URL ?? "";
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  resetDefaultConnectorObservationStoreCache();
  try {
    await fn(postgresHarness(databaseUrl));
  } finally {
    await closePostgresStorage();
    resetDefaultConnectorObservationStoreCache();
  }
}

/** Seeds one connection per (connector, instance) pair, then writes runs for it. */
async function seedAndPut(
  harness: Harness,
  connectorId: string,
  connectorInstanceId: string,
  runIds: readonly string[]
): Promise<void> {
  await harness.seedConnection(connectorId, connectorInstanceId);
  await inOrder(runIds, (runId) => storeOf().put(runInput(connectorId, connectorInstanceId, runId)));
}

async function contractPersistsExactSnapshot(harness: Harness): Promise<void> {
  const c = uniq("c-persist");
  const i = uniq("i-persist");
  await harness.seedConnection(c, i);
  const input = runInput(c, i, "run-persist");
  await storeOf().put(input);

  const expected = JSON.parse(JSON.stringify(input)) as ConnectorObservationRunInput;
  const readBack = await storeOf().get({
    connectorId: c,
    connectorInstanceId: i,
    runId: "run-persist",
  });
  assert.ok(readBack, "the record persists in the same process");
  assert.deepEqual(readBack.snapshot, expected.snapshot, "snapshot reads back exactly");
  assert.deepEqual(readBack.diagnosis, expected.diagnosis, "diagnosis reads back exactly");
  assert.equal(readBack.runId, "run-persist");
  assert.equal(readBack.connectorId, c);
  assert.equal(readBack.connectorInstanceId, i);

  await harness.reopen();
  const afterReopen = await storeOf().get({
    connectorId: c,
    connectorInstanceId: i,
    runId: "run-persist",
  });
  assert.deepEqual(afterReopen?.snapshot, expected.snapshot, "snapshot survives a reopen unchanged");
  assert.deepEqual(afterReopen?.diagnosis, expected.diagnosis, "diagnosis survives a reopen unchanged");

  const retired = readBack.snapshot.facts.filter((fact) => fact.retired);
  assert.deepEqual(
    retired.map((fact) => fact.id),
    ["run-persist-expect"],
    "the retirement flag set by the runtime is read back as supplied"
  );
  assert.deepEqual(
    readBack.snapshot.defects.map((defect) => defect.class),
    ["protocol_violation"],
    "the runtime defect is read back as supplied"
  );
}

async function contractNamespaceAndInstanceSeparation(harness: Harness): Promise<void> {
  const c1 = uniq("c1");
  const c2 = uniq("c2");
  const i1 = uniq("i1");
  const i2 = uniq("i2");
  const i3 = uniq("i3");
  await harness.seedConnection(c1, i1);
  await harness.seedConnection(c1, i2);
  await harness.seedConnection(c2, i3);
  await storeOf().put(runInput(c1, i1, "shared"));
  await storeOf().put(runInput(c1, i2, "shared"));
  await storeOf().put(runInput(c2, i3, "shared"));

  const fromI1 = await storeOf().get({
    connectorId: c1,
    connectorInstanceId: i1,
    runId: "shared",
  });
  const fromI2 = await storeOf().get({
    connectorId: c1,
    connectorInstanceId: i2,
    runId: "shared",
  });
  assert.equal(fromI1?.connectorInstanceId, i1, "exact instance lookup returns its own record");
  assert.equal(fromI2?.connectorInstanceId, i2, "a sibling instance with the same run id is a separate record");
  assert.equal(
    await storeOf().get({
      connectorId: c1,
      connectorInstanceId: uniq("i-missing"),
      runId: "shared",
    }),
    null,
    "an instance that did not write the run is not returned"
  );
  assert.equal(
    await storeOf().get({
      connectorId: c2,
      connectorInstanceId: i1,
      runId: "shared",
    }),
    null,
    "a different connector cannot read another connector's record by instance"
  );

  const c1All = await storeOf().list({ connectorId: c1 });
  assert.equal(c1All.length, 2, "list without an instance covers every instance of the connector");
  const c1OnlyI1 = await storeOf().list({
    connectorId: c1,
    connectorInstanceId: i1,
  });
  assert.deepEqual(
    c1OnlyI1.map((record) => record.connectorInstanceId),
    [i1],
    "list with an instance returns only that instance"
  );
  const c2Only = await storeOf().list({ connectorId: c2 });
  assert.deepEqual(
    c2Only.map((record) => record.connectorId),
    [c2],
    "list never returns another connector's records"
  );
}

async function contractRetentionIsPerConnector(harness: Harness): Promise<void> {
  const c1 = uniq("c1-retain");
  const c2 = uniq("c2-retain");
  const i1 = uniq("i1-retain");
  const i2 = uniq("i2-retain");
  const i3 = uniq("i3-retain");
  await harness.seedConnection(c1, i1);
  await harness.seedConnection(c1, i2);
  await harness.seedConnection(c2, i3);
  await inOrder(
    Array.from({ length: CAP + 2 }, (_, index) => index + 1),
    (n) => {
      const instance = n % 2 === 1 ? i1 : i2;
      return storeOf().put(runInput(c1, instance, `run-${pad(n)}`));
    }
  );
  await inOrder(
    Array.from({ length: 3 }, (_, index) => index + 1),
    (n) => storeOf().put(runInput(c2, i3, `run-${pad(n)}`))
  );

  const expectedRuns = Array.from({ length: CAP }, (_, index) => `run-${pad(CAP + 2 - index)}`);
  assert.deepEqual(
    (await storeOf().list({ connectorId: c1 })).map((record) => record.runId),
    expectedRuns,
    "connector c1 retains exactly its 8 newest runs, newest first"
  );
  assert.equal(await harness.rowCount(c1), CAP, "the 8-record cap counts runs across both instances");
  assert.deepEqual(
    (await storeOf().list({ connectorId: c1, connectorInstanceId: i1 })).map((record) => record.runId),
    ["run-09", "run-07", "run-05", "run-03"],
    "instance i1 holds only its own retained runs"
  );
  assert.equal(
    await storeOf().get({
      connectorId: c1,
      connectorInstanceId: i1,
      runId: "run-01",
    }),
    null,
    "the oldest run of connector c1 is pruned"
  );
  assert.equal(
    await storeOf().get({
      connectorId: c1,
      connectorInstanceId: i2,
      runId: "run-02",
    }),
    null,
    "a pruned run of the sibling instance is pruned too"
  );
  assert.equal(await harness.rowCount(c2), 3, "pruning connector c1 leaves connector c2 untouched");
  assert.ok(
    await storeOf().get({
      connectorId: c2,
      connectorInstanceId: i3,
      runId: "run-01",
    }),
    "connector c2 keeps its oldest record"
  );
}

async function contractOversizeRejectedBeforeMutation(harness: Harness): Promise<void> {
  const c = uniq("c-oversize");
  const i = uniq("i-oversize");
  await seedAndPut(
    harness,
    c,
    i,
    Array.from({ length: CAP }, (_, index) => `run-${pad(index + 1)}`)
  );
  const before = await harness.retainedSequences(c);
  const base = observedRun("oversize");
  const oversize = {
    connectorId: c,
    connectorInstanceId: i,
    diagnosis: base.diagnosis,
    runId: "run-oversize",
    snapshot: {
      ...base.snapshot,
      facts: [
        ...base.snapshot.facts,
        {
          attrs: {
            kind: "other",
            pad: "x".repeat(CONNECTOR_OBSERVATION_RECORD_MAX_BYTES),
          },
          fact: "provider_message",
          id: "pad",
          type: "OBSERVATION",
        },
      ],
    },
  } as unknown as ConnectorObservationRunInput;

  await expectStoreError(storeOf().put(oversize), "record_oversize", "an oversize record is rejected");
  assert.equal(await harness.rowCount(c), CAP, "an oversize write does not change the row count");
  assert.deepEqual(await harness.retainedSequences(c), before, "an oversize write does not prune or renumber");
  assert.equal(
    await storeOf().get({
      connectorId: c,
      connectorInstanceId: i,
      runId: "run-oversize",
    }),
    null,
    "the rejected record is not stored"
  );
  assert.ok(
    await storeOf().get({
      connectorId: c,
      connectorInstanceId: i,
      runId: "run-01",
    }),
    "the oldest retained run survives a rejected write"
  );
}

async function contractRepeatPutIsIdempotent(harness: Harness): Promise<void> {
  const c1 = uniq("c1-repeat");
  const c2 = uniq("c2-repeat");
  const i1 = uniq("i1-repeat");
  const i3 = uniq("i3-repeat");
  await harness.seedConnection(c1, i1);
  await harness.seedConnection(c2, i3);
  const original = runInput(c1, i1, "dup");
  await storeOf().put(original);
  await storeOf().put(original);
  assert.equal(await harness.rowCount(c1), 1, "a repeat put of the same run does not grow the row count");

  const conflicting: ConnectorObservationRunInput = {
    ...original,
    diagnosis: {
      attribution: "none",
      basis: [],
      category: "unknown",
      contributing: [],
    },
  };
  await expectStoreError(
    storeOf().put(conflicting),
    "record_conflict",
    "different content for the same run is rejected"
  );
  const stored = await storeOf().get({
    connectorId: c1,
    connectorInstanceId: i1,
    runId: "dup",
  });
  assert.equal(stored?.diagnosis.category, original.diagnosis.category, "the stored record keeps its original content");

  const other = runInput(c2, i3, "dup");
  await storeOf().put(other);
  const c1After = await storeOf().get({
    connectorId: c1,
    connectorInstanceId: i1,
    runId: "dup",
  });
  assert.deepEqual(c1After?.snapshot, original.snapshot, "a same-id run in another connector does not overwrite c1");
  assert.equal(
    (
      await storeOf().get({
        connectorId: c2,
        connectorInstanceId: i3,
        runId: "dup",
      })
    )?.connectorId,
    c2,
    "the other connector gets its own record"
  );
}

async function contractValidationAndLimit(harness: Harness): Promise<void> {
  const c = uniq("c-valid");
  const i = uniq("i-valid");
  await seedAndPut(
    harness,
    c,
    i,
    Array.from({ length: CAP + 2 }, (_, index) => `run-${pad(index + 1)}`)
  );

  await expectStoreError(
    storeOf().put({ ...runInput(c, i, "run-blank"), runId: "   " }),
    "record_invalid",
    "a blank run id is rejected"
  );
  const missingFacts = {
    ...runInput(c, i, "run-bad"),
    snapshot: { defects: [], truncated: false },
  } as unknown as ConnectorObservationRunInput;
  await expectStoreError(storeOf().put(missingFacts), "record_invalid", "a snapshot without facts is rejected");
  await inOrder(
    [
      { action: "refresh_credentials", attribution: "runtime", origin: "done_error" },
      { action: "arbitrary_action", attribution: "connector", origin: "done_error" },
      { action: "refresh_credentials", attribution: "connector", origin: "arbitrary_origin" },
      { action: "refresh_credentials", attribution: "connector", message: "private text", origin: "done_error" },
    ],
    (suggestion) => {
      const input = runInput(c, i, "invalid-suggestion");
      return expectStoreError(
        storeOf().put({
          ...input,
          snapshot: { ...input.snapshot, connector_suggestions: [suggestion] },
        } as unknown as ConnectorObservationRunInput),
        "record_invalid",
        "only closed connector-attributed suggestion fields may be persisted"
      );
    }
  );
  const excessiveSuggestions = runInput(c, i, "excessive-suggestions");
  await expectStoreError(
    storeOf().put({
      ...excessiveSuggestions,
      snapshot: {
        ...excessiveSuggestions.snapshot,
        connector_suggestions: Array.from({ length: 17 }, () => ({
          action: "refresh_credentials",
          attribution: "connector",
          origin: "done_error",
        })),
      },
    } as unknown as ConnectorObservationRunInput),
    "record_invalid",
    "suggestion storage is bounded by the sixteen portable action and origin pairs"
  );
  assert.equal(await harness.rowCount(c), CAP, "rejected records do not change the stored rows");

  assert.equal((await storeOf().list({ connectorId: c, limit: 100 })).length, CAP, "list limit clamps to 8");
  assert.equal((await storeOf().list({ connectorId: c, limit: 1 })).length, 1, "list honors a smaller limit");
  await assert.rejects(
    storeOf().list({ connectorId: c, limit: 0 }),
    ConnectorObservationStoreError,
    "limit 0 is rejected"
  );
}

async function contractDeletingConnectionCascades(harness: Harness): Promise<void> {
  const c = uniq("c-cascade");
  const deleted = uniq("i-cascade-deleted");
  const sibling = uniq("i-cascade-sibling");
  await seedAndPut(harness, c, deleted, ["run-01", "run-02"]);
  await harness.seedConnection(c, sibling);
  await storeOf().put(runInput(c, sibling, "run-03"));
  assert.equal(await harness.rowCount(c), 3, "three runs are recorded before the deletion");

  await harness.deleteConnection(deleted);
  assert.equal(
    await storeOf().get({
      connectorId: c,
      connectorInstanceId: deleted,
      runId: "run-01",
    }),
    null,
    "deleting a connection removes its run records through the foreign key"
  );
  assert.equal(await harness.rowCount(c), 1, "only the deleted connection's records are removed");
  assert.ok(
    await storeOf().get({
      connectorId: c,
      connectorInstanceId: sibling,
      runId: "run-03",
    }),
    "a sibling instance of the same connector keeps its record"
  );
}

async function contractRollsBackOnFault(harness: Harness): Promise<void> {
  const c = uniq("c-fault");
  const i = uniq("i-fault");
  await seedAndPut(
    harness,
    c,
    i,
    Array.from({ length: CAP }, (_, index) => `run-${pad(index + 1)}`)
  );
  const before = await harness.retainedSequences(c);

  await harness.installFault("prune");
  try {
    await assert.rejects(storeOf().put(runInput(c, i, "run-09")), PRUNE_FAULT, "a prune fault fails the write");
  } finally {
    await harness.removeFault("prune");
  }
  assert.equal(
    await storeOf().get({
      connectorId: c,
      connectorInstanceId: i,
      runId: "run-09",
    }),
    null,
    "the insert is rolled back when its prune fails"
  );
  assert.deepEqual(await harness.retainedSequences(c), before, "a rolled-back prune leaves sequences unchanged");

  await harness.installFault("insert");
  try {
    await assert.rejects(storeOf().put(runInput(c, i, "run-09")), INSERT_FAULT, "an insert fault fails the write");
  } finally {
    await harness.removeFault("insert");
  }
  assert.equal(await harness.rowCount(c), CAP, "a failed insert leaves the retained rows as they were");
  assert.deepEqual(await harness.retainedSequences(c), before, "a failed insert leaves sequences unchanged");

  await storeOf().put(runInput(c, i, "run-09"));
  assert.equal(await harness.rowCount(c), CAP, "after the faults are removed the write succeeds and prunes once");
}

async function contractConcurrentPutsKeepRetention(harness: Harness): Promise<void> {
  const c = uniq("c-race");
  const other = uniq("c-race-other");
  const instances = [uniq("i-race-a"), uniq("i-race-b"), uniq("i-race-c")];
  await inOrder(instances, (instance) => harness.seedConnection(c, instance));
  const otherInstance = uniq("i-race-other");
  await harness.seedConnection(other, otherInstance);
  const total = 3 * CAP;
  const writes = Array.from({ length: total }, (_, index) =>
    storeOf().put(runInput(c, instances[index % instances.length] ?? "", `run-${pad(index + 1)}`))
  );
  await Promise.all(writes);

  assert.equal(await harness.rowCount(c), CAP, "concurrent writers leave exactly 8 records for the connector");
  assert.deepEqual(
    await harness.retainedSequences(c),
    Array.from({ length: CAP }, (_, index) => total - CAP + 1 + index),
    "every write took a distinct sequence and the newest 8 survived"
  );

  const same = runInput(other, otherInstance, "same");
  await Promise.all([storeOf().put(same), storeOf().put(same)]);
  assert.equal(await harness.rowCount(other), 1, "concurrent identical puts store one row");
}

test("SQLite connector observation store: persists, reopens and reads back the exact snapshot", async () => {
  await withSqlite(contractPersistsExactSnapshot);
});

test("SQLite connector observation store: separates connector namespace and exact instance", async () => {
  await withSqlite(contractNamespaceAndInstanceSeparation);
});

test("SQLite connector observation store: retains 8 runs per connector across instances", async () => {
  await withSqlite(contractRetentionIsPerConnector);
});

test("SQLite connector observation store: rejects an oversize record before any mutation", async () => {
  await withSqlite(contractOversizeRejectedBeforeMutation);
});

test("SQLite connector observation store: a repeat put is idempotent and never takes another connector's run", async () => {
  await withSqlite(contractRepeatPutIsIdempotent);
});

test("SQLite connector observation store: validates identity and clamps list limit to 8", async () => {
  await withSqlite(contractValidationAndLimit);
});

test("SQLite connector observation store: rolls back the write when the prune or insert faults", async () => {
  await withSqlite(contractRollsBackOnFault);
});

test("SQLite connector observation store: deleting a connection cascades its run records", async () => {
  await withSqlite(contractDeletingConnectionCascades);
});

test("Postgres connector observation store: persists, reopens and reads back the exact snapshot", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withPostgres(contractPersistsExactSnapshot);
});

test("Postgres connector observation store: separates connector namespace and exact instance", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withPostgres(contractNamespaceAndInstanceSeparation);
});

test("Postgres connector observation store: retains 8 runs per connector across instances", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withPostgres(contractRetentionIsPerConnector);
});

test("Postgres connector observation store: rejects an oversize record before any mutation", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withPostgres(contractOversizeRejectedBeforeMutation);
});

test("Postgres connector observation store: a repeat put is idempotent and never takes another connector's run", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withPostgres(contractRepeatPutIsIdempotent);
});

test("Postgres connector observation store: validates identity and clamps list limit to 8", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withPostgres(contractValidationAndLimit);
});

test("Postgres connector observation store: rolls back the write when the prune or insert faults", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withPostgres(contractRollsBackOnFault);
});

test("Postgres connector observation store: concurrent puts keep retention and unique sequences", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withPostgres(contractConcurrentPutsKeepRetention);
});

test("Postgres connector observation store: deleting a connection cascades its run records", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withPostgres(contractDeletingConnectionCascades);
});
