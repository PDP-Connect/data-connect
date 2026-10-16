// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The checkpoint-withhold streak contract, on both backends: same reason on a
 * new run counts up, a replayed run does not, a different reason restarts at 1,
 * a commit clears the streak, and scopes never share a row.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  type CheckpointScope,
  type CheckpointWithholdStore,
  getDefaultCheckpointWithholdStore,
} from "../server/stores/checkpoint-withhold-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-10-16T00:00:00.000Z";
const SCOPE: CheckpointScope = { connectorId: "c", connectorInstanceId: "cin_1", grantId: null };

async function withhold(
  store: CheckpointWithholdStore,
  runId: string,
  withheld: Record<string, string>,
  { committed = [], scope = SCOPE }: { committed?: string[]; scope?: CheckpointScope } = {}
): Promise<Record<string, number>> {
  const counts = await store.recordCheckpointOutcomes({
    committed,
    nowIso: NOW,
    runId,
    scope,
    withheld: new Map(Object.entries(withheld)),
  });
  return Object.fromEntries(counts);
}

async function assertStreakContract(store: CheckpointWithholdStore): Promise<void> {
  assert.deepEqual(await withhold(store, "r1", { orders: "reason-a" }), { orders: 1 });
  assert.deepEqual(await withhold(store, "r2", { orders: "reason-a" }), { orders: 2 });
  assert.deepEqual(await withhold(store, "r2", { orders: "reason-a" }), { orders: 2 }, "a replayed run counts once");
  assert.deepEqual(await withhold(store, "r1", { orders: "reason-a" }), { orders: 2 }, "interleaved replay");
  assert.deepEqual(await withhold(store, "r3", { orders: "reason-b" }), { orders: 1 }, "a new reason restarts");
  assert.deepEqual(await withhold(store, "r4", { orders: "reason-b" }), { orders: 2 });

  const otherScope = { ...SCOPE, grantId: "grant_1" };
  assert.deepEqual(await withhold(store, "r5", { orders: "reason-b" }, { scope: otherScope }), { orders: 1 });

  assert.deepEqual(await withhold(store, "r6", { items: "reason-a" }, { committed: ["orders"] }), { items: 1 });
  assert.deepEqual(await withhold(store, "r7", { orders: "reason-b" }), { orders: 1 }, "a commit ends the streak");
  await withhold(store, "r6", {}, { committed: ["orders"] });
  assert.deepEqual(await withhold(store, "r8", { orders: "reason-b" }), { orders: 2 }, "old commit cannot reset");
  assert.deepEqual(await withhold(store, "r1", { orders: "reason-a" }), { orders: 2 }, "old withhold cannot reset");
  assert.deepEqual(await withhold(store, "r8", { orders: "reason-b" }, { scope: otherScope }), { orders: 2 });
}

test("SQLite checkpoint withhold streaks count consecutive same-reason runs per scope", async () => {
  initDb(":memory:");
  try {
    await assertStreakContract(getDefaultCheckpointWithholdStore());
  } finally {
    closeDb();
  }
});

test("Postgres checkpoint withhold streaks match the SQLite contract", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL ?? "" });
  try {
    await postgresQuery("DELETE FROM connector_checkpoint_withholds WHERE connector_id = $1", [SCOPE.connectorId]);
    await assertStreakContract(getDefaultCheckpointWithholdStore());
  } finally {
    await closePostgresStorage();
  }
});


test("SQLite ignores interleaved same-run withhold replays", async () => {
  initDb(":memory:");
  try {
    const store = getDefaultCheckpointWithholdStore();
    assert.deepEqual(await withhold(store, "r1", { orders: "a" }), { orders: 1 });
    assert.deepEqual(await withhold(store, "r2", { orders: "a" }), { orders: 2 });
    assert.deepEqual(await withhold(getDefaultCheckpointWithholdStore(), "r1", { orders: "a" }), { orders: 2 });
    assert.deepEqual(await withhold(store, "r3", { orders: "a" }), { orders: 3 });
  } finally {
    closeDb();
  }
});

test("SQLite ignores old commits and withholds replayed across a commit", async () => {
  initDb(":memory:");
  try {
    const store = getDefaultCheckpointWithholdStore();
    await withhold(store, "r1", { orders: "a" });
    await withhold(store, "r2", {}, { committed: ["orders"] });
    assert.deepEqual(await withhold(store, "r3", { orders: "a" }), { orders: 1 });
    await withhold(store, "r2", {}, { committed: ["orders"] });
    assert.deepEqual(await withhold(store, "r4", { orders: "a" }), { orders: 2 });
    assert.deepEqual(await withhold(store, "r1", { orders: "a" }), { orders: 2 });
    assert.deepEqual(await withhold(store, "r5", { orders: "b" }), { orders: 1 });
    assert.deepEqual(await withhold(store, "r4", { orders: "a" }), { orders: 1 });
  } finally {
    closeDb();
  }
});

test("SQLite upgrades legacy scalar run ids without recounting them", async () => {
  initDb(":memory:");
  try {
    const store = getDefaultCheckpointWithholdStore();
    await withhold(store, "legacy", { orders: "a" });
    getDb().prepare("UPDATE connector_checkpoint_withholds SET last_run_id = ?").run("legacy");
    assert.deepEqual(await withhold(store, "legacy", { orders: "a" }), { orders: 1 });
    assert.deepEqual(await withhold(store, "next", { orders: "a" }), { orders: 2 });
    await withhold(store, "commit", {}, { committed: ["orders"] });
    assert.deepEqual(await withhold(store, "legacy", { orders: "a" }), { orders: 0 });
    assert.deepEqual(await withhold(store, "fresh", { orders: "a" }), { orders: 1 });
  } finally {
    closeDb();
  }
});
