// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DCR-74: pins the storage-generation guards that already exist in the
// reconcile path. Old work is parked, storage is closed and re-opened on a
// different database (production's close-then-init), and the old work is
// resumed; the new database must be left as it was seeded. See
// test/helpers/lifecycle-race.ts for how the new database is seeded so that
// every other guard (manifest, record version, dirty revision) would pass.
//
//   - dirty clear: the reconcile clears a scope's dirty mark in one write at the
//     end. The new database is already in sync, so every backfill await before
//     it is a read; the generation checks in runScopeBackfills (after each
//     backfill and inside the clearing transaction) are all that stop the clear.
//     The new database holds the same dirty revision, so the revision check
//     alone would let the clear through.
//   - round loop: runSearchIndexDirtyReconcileRound captures the generation once
//     and drops the rest of the round when it changes.
//   - SQLite vector publish (embedding call): the semantic backfill resolves its
//     vector index before the embedding call, so the write goes to the closed
//     old handle and fails. That is the only thing that stops a vector write on
//     SQLite until the backfill checks the generation itself.

import assert from "node:assert/strict";
import test from "node:test";
import { ingestRecord } from "../server/records.ts";
import { __setLexicalBackfillPhaseHookForTest } from "../server/search.ts";
import { reconcileSearchIndexDirtyScope, runSearchIndexDirtyReconcileRound } from "../server/search-index-reconcile.ts";
import { configureSemanticBackend, makeStubBackend } from "../server/search-semantic.ts";
import { listDirtySearchIndexScopes } from "../server/stores/search-index-dirty-store.ts";
import {
  assertNewDatabaseUntouched,
  backendKits,
  CONNECTOR_ID,
  derivedState,
  INSTANCE_ID,
  NEW_TEXT,
  oneShotGate,
  recordEnvelope,
  STREAM,
  seedInSyncLexicalIndex,
  withTwoSqliteDatabases,
} from "./helpers/lifecycle-race.ts";

async function dirtyScope() {
  const scope = (await listDirtySearchIndexScopes(10)).find(
    (candidate) => candidate.connectorInstanceId === INSTANCE_ID && candidate.stream === STREAM
  );
  assert.ok(scope, "the old database has the dirty scope to reconcile");
  return scope;
}

for (const kit of backendKits) {
  test(`${kit.name}: a reconcile parked before its first read cannot clear the replaced database's dirty mark`, {
    concurrency: false,
    skip: kit.skip,
    timeout: 60_000,
  }, async () => {
    const gate = oneShotGate();
    configureSemanticBackend(null);
    __setLexicalBackfillPhaseHookForTest(async (point: string) => {
      if (point === "before-instance-fence") {
        await gate.park();
      }
    });
    try {
      await kit.run(async (dbs) => {
        await dbs.openOld({ deferIndexes: true, semantic: false });
        const reconcile = reconcileSearchIndexDirtyScope(await dirtyScope());
        await gate.entered;

        const seeded = await dbs.replaceWithFresh({ semantic: false });
        await seedInSyncLexicalIndex(NEW_TEXT);
        const seededState = await derivedState();
        assert.equal(seededState.dirty[0]?.dirty, 1, "the new database starts dirty");
        assert.equal(seededState.dirty[0]?.revision, seeded.revision);
        assert.equal(seededState.lexicalMeta, 1, "the new database starts in sync, so a backfill there writes nothing");

        gate.release();
        const result = await reconcile;
        assert.equal(result.outcome, "failed", "old reconcile is dropped: not converged, not recontended");
        assert.deepEqual(
          await derivedState(),
          seededState,
          "the new database is exactly as seeded: dirty mark kept, nothing written"
        );
      });
    } finally {
      gate.release();
      __setLexicalBackfillPhaseHookForTest(null);
    }
  });

  test(`${kit.name}: a reconcile round drops its remaining scopes when storage is replaced`, {
    concurrency: false,
    skip: kit.skip,
    timeout: 60_000,
  }, async () => {
    const gate = oneShotGate();
    configureSemanticBackend(null);
    __setLexicalBackfillPhaseHookForTest(async (point: string) => {
      if (point === "before-instance-fence") {
        await gate.park();
      }
    });
    try {
      await kit.run(async (dbs) => {
        await dbs.openOld({ deferIndexes: true, semantic: false });
        // A second dirty scope in the old database, so the round has a next scope to skip.
        await ingestRecord(
          { connector_id: CONNECTOR_ID, connector_instance_id: `${INSTANCE_ID}_second` },
          recordEnvelope("k1", "second instance"),
          { deferIndexes: true }
        );
        assert.equal((await listDirtySearchIndexScopes(10)).length, 2, "the old database has two dirty scopes");
        const round = runSearchIndexDirtyReconcileRound({ maxDurationMs: 30_000, pageSize: 10 });
        await gate.entered;

        await dbs.replaceWithFresh({ semantic: false });
        await seedInSyncLexicalIndex(NEW_TEXT);
        const seededState = await derivedState();

        gate.release();
        const result = await round;
        assert.equal(result.attempted, 1, "the round stopped after the scope it was in when storage was replaced");
        assert.equal(result.incomplete, true, "the round reports that it left scopes undone");
        assert.equal(result.succeeded, 0, "the old scope was dropped, not converged");
        assert.deepEqual(await derivedState(), seededState, "the new database is exactly as seeded");
      });
    } finally {
      gate.release();
      __setLexicalBackfillPhaseHookForTest(null);
    }
  });
}

test("SQLite: a semantic backfill parked at the embedding call cannot publish vectors into the replaced database", {
  concurrency: false,
  timeout: 30_000,
}, async () => {
  const gate = oneShotGate();
  const stub = makeStubBackend({ dimensions: 8 });
  configureSemanticBackend({
    ...stub,
    embedDocument: async (text: string) => {
      await gate.park();
      return stub.embedDocument(text);
    },
  });
  try {
    await withTwoSqliteDatabases(async (dbs) => {
      await dbs.openOld({ deferIndexes: true, semantic: true });
      const reconcile = reconcileSearchIndexDirtyScope(await dirtyScope());
      await gate.entered;

      const seeded = await dbs.replaceWithFresh({ semantic: true });
      assertNewDatabaseUntouched(await derivedState(), seeded.revision, "before resume (seed check)");

      gate.release();
      const result = await reconcile;
      assert.equal(result.outcome, "failed", "old reconcile is dropped: not converged, not recontended");
      assertNewDatabaseUntouched(
        await derivedState(),
        seeded.revision,
        "old reconcile released from the embedding call"
      );
    });
  } finally {
    gate.release();
    configureSemanticBackend(null);
  }
});
