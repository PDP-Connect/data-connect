// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DCR-74: storage-generation replacement must not let OLD deferred index work
// write into the NEW database, at any await between "the generation was
// captured" and "the code writes to storage".
//
// Each test parks old work at one of those awaits, closes storage and opens a
// different database (production's close-then-init), resumes, and asserts the
// new database holds no row the old work could have produced. The new database
// is seeded so every other guard (manifest, record version, dirty revision)
// would pass; see test/helpers/lifecycle-race.ts. Each section names the writers
// and the awaits it pauses at; the awaits it does not pause at, and why, are in
// the PR body.
//
// PostgreSQL pauses sit outside any open transaction: closing the old pool waits
// for checked-out connections, so a pause inside a transaction would hang the
// close instead of replacing storage.

import assert from "node:assert/strict";
import test from "node:test";
import { __setIndexPublishPhaseHookForTest, recordIndexWorkStatsForGenerationForTests } from "../server/records.ts";
import { __setLexicalBackfillPhaseHookForTest } from "../server/search.ts";
import {
  __setSearchIndexReconcilePhaseHookForTest,
  reconcileSearchIndexDirtyScope,
} from "../server/search-index-reconcile.ts";
import {
  __setSemanticRepairPhaseHookForTest,
  configureSemanticBackend,
  makeStubBackend,
} from "../server/search-semantic.ts";
import { currentStorageGeneration } from "../server/storage-generation.ts";
import { listDirtySearchIndexScopes } from "../server/stores/search-index-dirty-store.ts";
import {
  assertNewDatabaseUntouched,
  type BackendKit,
  backendKits,
  currentRecordText,
  derivedState,
  GHOST_ROW,
  INSTANCE_ID,
  insertGhostLexicalRow,
  insertStaleSemanticMeta,
  NEW_TEXT,
  oneShotGate,
  STREAM,
  trackUnhandledRejections,
  until,
} from "./helpers/lifecycle-race.ts";

async function dirtyScope() {
  const scope = (await listDirtySearchIndexScopes(10)).find(
    (candidate) => candidate.connectorInstanceId === INSTANCE_ID && candidate.stream === STREAM
  );
  assert.ok(scope, "the old database has the dirty scope to reconcile");
  return scope;
}

for (const kit of backendKits) {
  recordIndexMaintenanceTests(kit);
  lexicalBackfillTests(kit);
  semanticBackfillTests(kit);
  removedStreamSemanticCleanupTests(kit);
  retainedEvidenceTests(kit);
}

// --- Deferred record index maintenance (records.ts maintainRecordIndexesWithinPermit) ---
//
// withIndexWork re-checks the storage generation just before it starts the
// operation. The operation then awaits, and only afterwards writes:
//   1. dynamic imports of the lexical and semantic modules (cached; no storage touch)
//   2. computeLexicalFields (pure) and computeSemanticEntries (manifest read, embedding call)
//   3. maybeIndexPublishPhase "before-publish-transaction" (the test seam)
//   4. the publish transaction (lexical rows, semantic vectors) <- the write
// Every await in 1-3 leads to the single write in 4. The two pauses are the
// embedding call (the slowest real await) and the seam directly before the write.
function recordIndexMaintenanceTests(kit: BackendKit) {
  for (const pause of ["embedding-call", "before-publish-transaction"] as const) {
    test(`${kit.name}: record index maintenance parked at ${pause} does not write into the replaced database`, {
      concurrency: false,
      skip: kit.skip,
      timeout: 60_000,
    }, async () => {
      const gate = oneShotGate();
      const rejections = trackUnhandledRejections();
      const stub = makeStubBackend({ dimensions: 8 });
      configureSemanticBackend(
        pause === "embedding-call"
          ? {
              ...stub,
              embedDocument: async (text: string) => {
                await gate.park();
                return stub.embedDocument(text);
              },
            }
          : stub
      );
      if (pause === "before-publish-transaction") {
        __setIndexPublishPhaseHookForTest(async (point: string) => {
          if (point === "before-publish-transaction") {
            await gate.park();
          }
        });
      }
      try {
        await kit.run(async (dbs) => {
          await dbs.openOld({ deferIndexes: false, semantic: true });
          const oldGeneration = currentStorageGeneration();
          await gate.entered;
          assert.deepEqual(
            recordIndexWorkStatsForGenerationForTests(oldGeneration),
            { active: 1, queued: 0 },
            "the old job is parked inside its admission permit, past the start-of-job generation check"
          );

          const seeded = await dbs.replaceWithFresh({ semantic: true });
          assert.notEqual(currentStorageGeneration(), oldGeneration, "storage moved to a new generation");
          assertNewDatabaseUntouched(await derivedState(), seeded.revision, "before resume (seed check)");

          gate.release();
          await until(
            () => recordIndexWorkStatsForGenerationForTests(oldGeneration).active === 0,
            "the old job to finish"
          );
          // Let any fire-and-forget tail of the old job settle.
          for (let turn = 0; turn < 5; turn += 1) {
            // biome-ignore lint/performance/noAwaitInLoops: yield a few turns, order matters.
            await new Promise((resolve) => setImmediate(resolve));
          }
          assert.ok((await currentRecordText()).includes(NEW_TEXT), "the new database still holds its own record text");
          assertNewDatabaseUntouched(await derivedState(), seeded.revision, `old job released from ${pause}`);
        });
        assert.deepEqual(rejections.stop(), [], "the old job exits without an unhandled rejection");
      } finally {
        gate.release();
        __setIndexPublishPhaseHookForTest(null);
        configureSemanticBackend(null);
      }
    });
  }
}

// --- Reconcile -> lexical backfill (search-index-reconcile.ts -> search.ts) ---
//
// The reconcile captures the storage generation and hands it to
// lexicalIndexBackfillForManifest, which runs many awaits (record page reads,
// the per-instance write lock, the manifest check) before each write. Every
// write goes through withLexicalBackfillWrite. The writers, and the await
// (test seam) directly before each:
//   page write ........... rebuildLexicalIndexForStream  <- "after-page-fetch"
//   stale-row prune ...... pruneStaleSqliteLexicalPage   <- "after-stale-page-check" (SQLite only)
//   stream cleanup ....... deleteLexicalBackfillStream   <- "before-stream-cleanup"
//   fingerprint upsert ... backfillLexicalStream         <- "before-meta-publication"
// Awaits before a page read (the fingerprint read, the count reads, the
// "before-instance-fence" seam) only read; the next write behind them is one of
// the four above, behind the same check. The PostgreSQL stale prune has only a
// seam inside its open transaction, so it is not paused.
function lexicalBackfillTests(kit: BackendKit) {
  const cases = [
    { ghost: false, lexical: true, name: "page write", point: "after-page-fetch", sqliteOnly: false },
    { ghost: true, lexical: true, name: "stale-row prune", point: "after-stale-page-check", sqliteOnly: true },
    { ghost: true, lexical: false, name: "stream cleanup", point: "before-stream-cleanup", sqliteOnly: false },
    {
      ghost: false,
      lexical: true,
      name: "fingerprint publication",
      point: "before-meta-publication",
      sqliteOnly: false,
    },
  ] as const;
  for (const pause of cases) {
    if (pause.sqliteOnly && kit.name !== "SQLite") {
      continue;
    }
    test(`${kit.name}: lexical backfill parked before the ${pause.name} does not write into the replaced database`, {
      concurrency: false,
      skip: kit.skip,
      timeout: 60_000,
    }, async () => {
      const gate = oneShotGate();
      configureSemanticBackend(null);
      __setLexicalBackfillPhaseHookForTest(async (point: string) => {
        if (point === pause.point) {
          await gate.park();
        }
      });
      // A ghost row is one a stale prune or a stream cleanup would delete in either database.
      const expectedRows = pause.ghost ? [GHOST_ROW] : [];
      try {
        await kit.run(async (dbs) => {
          await dbs.openOld({ deferIndexes: true, lexical: pause.lexical, semantic: false });
          if (pause.ghost) {
            await insertGhostLexicalRow();
          }
          const reconcile = reconcileSearchIndexDirtyScope(await dirtyScope());
          await gate.entered;

          const seeded = await dbs.replaceWithFresh({ lexical: pause.lexical, semantic: false });
          if (pause.ghost) {
            await insertGhostLexicalRow();
          }
          assertNewDatabaseUntouched(await derivedState(), seeded.revision, "before resume (seed check)", {
            lexicalRows: expectedRows,
          });

          gate.release();
          const result = await reconcile;
          assert.equal(result.outcome, "failed", "old reconcile is dropped: not converged, not recontended");
          assertNewDatabaseUntouched(
            await derivedState(),
            seeded.revision,
            `old reconcile released from ${pause.point}`,
            { lexicalRows: expectedRows }
          );
        });
      } finally {
        gate.release();
        __setLexicalBackfillPhaseHookForTest(null);
      }
    });
  }
}

// --- Reconcile -> semantic backfill (search-index-reconcile.ts -> search-semantic.ts) ---
//
// Same shape: the reconcile captures the generation and hands it to
// semanticIndexBackfillForManifest. The backfill awaits (record page reads, the
// embedding call, the per-instance write lock, the manifest check) before each
// write. The writers, and the await directly before each:
//   backfill progress upsert ... rebuildSemanticBackfillInstance <- "before-progress-upsert"
//   field-batch vector publish . rebuildSemanticIndexForStream   <- the embedding call
//   meta upsert, progress delete rebuildSemanticBackfillInstance <- "after-verification"
// Awaits before the progress upsert (meta, progress and record page reads, the
// manifest check) only read and lead to that upsert. The page and orphan prune
// writes delete only rows that are obsolete in whichever database holds them
// and run the same assertSemanticRepairBackend call; they are not paused here.
function semanticBackfillTests(kit: BackendKit) {
  // On SQLite the embedding-call pause is pinned in lifecycle-race-guards.test.ts: the write
  // fails there on the closed old index handle. PostgreSQL has no such handle.
  const pauses =
    kit.name === "PostgreSQL"
      ? (["before-progress-upsert", "embedding-call", "after-verification"] as const)
      : (["before-progress-upsert", "after-verification"] as const);
  for (const pause of pauses) {
    test(`${kit.name}: semantic backfill parked at ${pause} does not write into the replaced database`, {
      concurrency: false,
      skip: kit.skip,
      timeout: 60_000,
    }, async () => {
      const gate = oneShotGate();
      const stub = makeStubBackend({ dimensions: 8 });
      configureSemanticBackend(
        pause === "embedding-call"
          ? {
              ...stub,
              embedDocument: async (text: string) => {
                await gate.park();
                return stub.embedDocument(text);
              },
            }
          : stub
      );
      __setSemanticRepairPhaseHookForTest(async (phase) => {
        if (phase === pause) {
          await gate.park();
        }
      });
      try {
        await kit.run(async (dbs) => {
          await dbs.openOld({ deferIndexes: true, semantic: true });
          const reconcile = reconcileSearchIndexDirtyScope(await dirtyScope());
          await gate.entered;

          const seeded = await dbs.replaceWithFresh({ semantic: true });
          assertNewDatabaseUntouched(await derivedState(), seeded.revision, "before resume (seed check)");

          gate.release();
          const result = await reconcile;
          assert.equal(result.outcome, "failed", "old reconcile is dropped: not converged, not recontended");
          assertNewDatabaseUntouched(await derivedState(), seeded.revision, `old reconcile released from ${pause}`);
        });
      } finally {
        gate.release();
        __setSemanticRepairPhaseHookForTest(null);
        configureSemanticBackend(null);
      }
    });
  }
}

// The removed-stream scope's semantic cleanup ends with one write that deletes the
// stream's semantic meta and backfill progress (pruneRemovedSemanticStream). It runs
// after the candidate pages and the per-instance write lock, which are awaits; the
// pause is the "before-orphan-prune" seam in front of them. The new database holds a
// semantic meta row for the same removed stream, which the stale write would delete.
// SQLite is not paused here: its cleanup first reads the vec0 inventory, a TEMP table on the old
// connection, which fails once that connection is closed (measured: with the new check removed
// the SQLite variant of this test still passes).
function removedStreamSemanticCleanupTests(kit: BackendKit) {
  if (kit.name !== "PostgreSQL") {
    return;
  }
  test(`${kit.name}: removed-stream semantic cleanup parked before the orphan prune does not delete from the replaced database`, {
    concurrency: false,
    skip: kit.skip,
    timeout: 60_000,
  }, async () => {
    const gate = oneShotGate();
    configureSemanticBackend(makeStubBackend({ dimensions: 8 }));
    __setSemanticRepairPhaseHookForTest(async (phase) => {
      if (phase === "before-orphan-prune") {
        await gate.park();
      }
    });
    try {
      await kit.run(async (dbs) => {
        await dbs.openOld({ deferIndexes: true, removedStream: true, semantic: true });
        await insertStaleSemanticMeta();
        const reconcile = reconcileSearchIndexDirtyScope(await dirtyScope());
        await gate.entered;

        const seeded = await dbs.replaceWithFresh({ removedStream: true, semantic: true });
        await insertStaleSemanticMeta();
        assertNewDatabaseUntouched(await derivedState(), seeded.revision, "before resume (seed check)", {
          semanticMeta: 1,
        });

        gate.release();
        const result = await reconcile;
        assert.equal(result.outcome, "failed", "old reconcile is dropped: not converged, not recontended");
        assertNewDatabaseUntouched(
          await derivedState(),
          seeded.revision,
          "old reconcile released from before-orphan-prune",
          {
            semanticMeta: 1,
          }
        );
      });
    } finally {
      gate.release();
      __setSemanticRepairPhaseHookForTest(null);
      configureSemanticBackend(null);
    }
  });
}

// --- Reconcile retained-dirty evidence (search-index-reconcile.ts runScopeBackfills) ---
//
// After both backfills the reconcile awaits hasSemanticIndexState and, when
// stale semantic state remains with no backend, writes failure evidence
// (last_error, attempts, next_attempt_at) onto the scope's dirty row. That
// write checks only the dirty revision. A new database that holds the same
// scope at the same revision would take the old run's evidence and its retry
// backoff, which delays the new database's own repair. The old run is parked at
// "before-retained-evidence", directly after that read.
function retainedEvidenceTests(kit: BackendKit) {
  test(`${kit.name}: retained-dirty evidence parked after the semantic-state read is not written into the replaced database`, {
    concurrency: false,
    skip: kit.skip,
    timeout: 60_000,
  }, async () => {
    const gate = oneShotGate();
    configureSemanticBackend(null);
    __setSearchIndexReconcilePhaseHookForTest(async (point) => {
      if (point === "before-retained-evidence") {
        await gate.park();
      }
    });
    try {
      await kit.run(async (dbs) => {
        // Lexical only: no semantic fields and no backend, plus leftover semantic meta,
        // so the reconcile takes the "stale semantic state remains" branch.
        await dbs.openOld({ deferIndexes: true, semantic: false });
        await insertStaleSemanticMeta();
        const reconcile = reconcileSearchIndexDirtyScope(await dirtyScope());
        await gate.entered;

        const seeded = await dbs.replaceWithFresh({ semantic: false });
        assertNewDatabaseUntouched(await derivedState(), seeded.revision, "before resume (seed check)");

        gate.release();
        const result = await reconcile;
        assert.equal(result.outcome, "failed", "old reconcile is dropped: not converged, not recontended");
        assertNewDatabaseUntouched(
          await derivedState(),
          seeded.revision,
          "old reconcile released from before-retained-evidence"
        );
      });
    } finally {
      gate.release();
      __setSearchIndexReconcilePhaseHookForTest(null);
    }
  });
}
