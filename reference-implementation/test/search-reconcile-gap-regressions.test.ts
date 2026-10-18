// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import { __setLexicalBackfillPhaseHookForTest } from "../server/search.ts";
import {
  __setSearchIndexDirtySelfHealRoundForTest,
  reconcileSearchIndexDirtyScope,
  runSearchIndexDirtyReconcileRound,
  triggerSearchIndexDirtySelfHeal,
} from "../server/search-index-reconcile.ts";
import { configureSemanticBackend } from "../server/search-semantic.ts";
import {
  isSearchIndexScopeDirty,
  listDirtySearchIndexScopes,
  markSearchIndexDirtySqlite,
} from "../server/stores/search-index-dirty-store.ts";

function manifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        query: { search: { lexical_fields: ["subject"] } },
        schema: {
          properties: { id: { type: "string" }, subject: { type: "string" } },
          required: ["id", "subject"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

async function seed(connectorId: string, instance: string, key = "k1") {
  const outcome = await ingestRecord(
    { connector_id: connectorId, connector_instance_id: instance },
    {
      data: { id: key, subject: `canonical ${key}` },
      emitted_at: "2026-07-16T00:00:00.000Z",
      key,
      stream: "items",
    },
    { deferIndexes: true }
  );
  assert.equal(outcome.accepted, true);
}

function mark(connectorId: string, instance: string) {
  markSearchIndexDirtySqlite(
    { connectorId, connectorInstanceId: instance, stream: "items" },
    "2026-07-16T00:00:00.000Z"
  );
}

async function scope(instance: string) {
  const result = (await listDirtySearchIndexScopes(100)).find(
    (s) => s.connectorInstanceId === instance && s.stream === "items"
  );
  assert.ok(result, "fixture must have an eligible dirty scope");
  return result;
}

function lexicalRows(instance: string) {
  return getDb()
    .prepare(
      "SELECT rowid, record_key, field, text FROM lexical_search_index " +
        "WHERE connector_instance_id = ? AND stream = ? ORDER BY record_key, field, rowid"
    )
    .all(instance, "items");
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5000;
  // biome-ignore lint/performance/noAwaitInLoops: Poll a test-visible async state until it settles.
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, "timed out waiting for observable repair state");
    await nextTurn();
  }
}

function reset() {
  __setLexicalBackfillPhaseHookForTest(null);
  __setSearchIndexDirtySelfHealRoundForTest(null);
  configureSemanticBackend(null);
  closeDb();
}

test("G3: exact-scope dedup permits siblings and unlocks after a failing owner", {
  concurrency: false,
  timeout: 15_000,
}, async () => {
  initDb(":memory:");
  configureSemanticBackend(null);
  const connectorId = "gap-scope-flight";
  const instance = "cin_gap_scope_a";
  const sibling = "cin_gap_scope_b";
  const entered = latch();
  const release = latch();
  let first: ReturnType<typeof reconcileSearchIndexDirtyScope> | undefined;
  let duplicate: ReturnType<typeof reconcileSearchIndexDirtyScope> | undefined;
  let entries = 0;
  try {
    await registerConnector(manifest(connectorId));
    await seed(connectorId, instance);
    await seed(connectorId, sibling);
    const observed = await scope(instance);
    __setLexicalBackfillPhaseHookForTest(async (phase, context) => {
      if (phase === "before-instance-fence" && context.connectorInstanceId === instance) {
        entries += 1;
        entered.release();
        await release.promise;
        throw new Error("G3 injected owner failure");
      }
    });
    first = reconcileSearchIndexDirtyScope(observed);
    await entered.promise;
    duplicate = reconcileSearchIndexDirtyScope(observed);
    await nextTurn();
    await nextTurn();
    assert.equal(entries, 1, "duplicate caller never enters backfill");
    assert.equal((await duplicate).outcome, "incomplete");
    assert.equal(
      (await reconcileSearchIndexDirtyScope(await scope(sibling))).outcome,
      "converged",
      "a different exact scope is not blocked by a global lock"
    );
    release.release();
    assert.equal((await first).outcome, "failed");
    __setLexicalBackfillPhaseHookForTest(null);
    assert.equal(
      (await reconcileSearchIndexDirtyScope(observed)).outcome,
      "converged",
      "finally must remove the failed owner's scope from the in-flight set"
    );
    assert.equal(lexicalRows(instance).length, 1);
    assert.equal(await isSearchIndexScopeDirty({ connectorInstanceId: instance, stream: "items" }), false);
  } finally {
    release.release();
    await first?.catch(() => undefined);
    await duplicate?.catch(() => undefined);
    reset();
  }
});

test("G4: read-time self-heal returns synchronously, deduplicates and can run again", {
  concurrency: false,
  timeout: 15_000,
}, async () => {
  initDb(":memory:");
  configureSemanticBackend(null);
  const connectorId = "gap-self-heal";
  const instance = "cin_gap_self_heal";
  const entered = latch();
  const release = latch();
  const firstRoundSettled = latch();
  let rounds = 0;
  try {
    await registerConnector(manifest(connectorId));
    await seed(connectorId, instance);
    __setSearchIndexDirtySelfHealRoundForTest(async () => {
      rounds += 1;
      entered.release();
      await release.promise;
      firstRoundSettled.release();
      return { attempted: 0, failed: 0, incomplete: false, recontended: 0, succeeded: 0 };
    });
    assert.equal(triggerSearchIndexDirtySelfHeal(), undefined, "must return void, never a repair Promise");
    await entered.promise;
    for (let i = 0; i < 20; i += 1) {
      assert.equal(triggerSearchIndexDirtySelfHeal(), undefined);
    }
    // Let any erroneously spawned attempts reach their asynchronous entry.
    await nextTurn();
    await nextTurn();
    assert.equal(rounds, 1, "concurrent triggers must start one outer round");
    assert.equal(await isSearchIndexScopeDirty({ connectorInstanceId: instance, stream: "items" }), true);
    release.release();
    await firstRoundSettled.promise;
    await nextTurn();
    await nextTurn();
    mark(connectorId, instance);
    triggerSearchIndexDirtySelfHeal();
    await until(() => rounds === 2);
    assert.equal(rounds, 2, "settled self-heal must release its marker for later dirty work");
  } finally {
    release.release();
    await nextTurn();
    await nextTurn();
    reset();
  }
});

test("G5: deadline stops between scopes and CAS contention is counted separately", {
  concurrency: false,
  timeout: 15_000,
}, async (t) => {
  initDb(":memory:");
  configureSemanticBackend(null);
  const connectorId = "gap-round-accounting";
  const first = "cin_gap_round_a";
  const second = "cin_gap_round_b";
  let now = 1000;
  try {
    await registerConnector(manifest(connectorId));
    await seed(connectorId, first);
    await seed(connectorId, second);
    // Equal timestamps force the documented instance-ID ordering.
    mark(connectorId, first);
    mark(connectorId, second);
    t.mock.method(Date, "now", () => now);
    assert.deepEqual(await runSearchIndexDirtyReconcileRound({ maxDurationMs: 0, pageSize: 10 }), {
      attempted: 0,
      failed: 0,
      incomplete: true,
      recontended: 0,
      succeeded: 0,
    });
    let raced = false;
    __setLexicalBackfillPhaseHookForTest((phase, context) => {
      if (phase === "before-meta-publication" && context.connectorInstanceId === first && !raced) {
        raced = true;
        mark(connectorId, first);
        now = 2000; // deadline is 1100; finish this scope, do not start the next.
      }
    });
    const result = await runSearchIndexDirtyReconcileRound({ maxDurationMs: 100, pageSize: 10 });
    assert.equal(raced, true, "fixture must cross the actual publication barrier");
    assert.deepEqual(result, {
      attempted: 1,
      failed: 0,
      incomplete: true,
      recontended: 1,
      succeeded: 0,
    });
    assert.equal(await isSearchIndexScopeDirty({ connectorInstanceId: first, stream: "items" }), true);
    assert.equal(await isSearchIndexScopeDirty({ connectorInstanceId: second, stream: "items" }), true);
    assert.deepEqual(lexicalRows(second), [], "deadline must prevent starting the second backfill");
    __setLexicalBackfillPhaseHookForTest(null);
    now = 3000;
    const recovery = await runSearchIndexDirtyReconcileRound({ maxDurationMs: 100, pageSize: 10 });
    assert.deepEqual(recovery, {
      attempted: 2,
      failed: 0,
      incomplete: false,
      recontended: 0,
      succeeded: 2,
    });
  } finally {
    t.mock.restoreAll();
    reset();
  }
});
