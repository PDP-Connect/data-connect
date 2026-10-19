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
import { getDb } from "../server/db.ts";
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
  CONNECTOR_ID,
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

// --- Lazy vector-index creation (search-semantic.ts ensureVectorIndex) ---
//
// ensureVectorIndex binds the CURRENT database and, when the physical vec0 table disagrees with
// the work's dimensions or metric, drops it and deletes every semantic sidecar, meta, progress and
// snapshot row before recreating it. Two deferred paths reach it after an await that can span a
// storage replacement: the semantic backfill (manifest and instance reads) and the record
// maintenance compute (manifest read). Each is parked at the seam directly before the lazy
// initialization. The new database already holds a populated vec0 table of another width and metric,
// so a stale initialization shows up as a changed schema or lost rows.
function lazyVectorIndexInitTests() {
  const cases = [
    { name: "semantic backfill", phase: "before-backfill-index-init" },
    { name: "record index maintenance compute", phase: "before-record-index-init" },
  ] as const;
  for (const pause of cases) {
    test(`SQLite: ${pause.name} parked before the lazy vector-index init does not rebuild the replaced database's vector table`, {
      concurrency: false,
      timeout: 60_000,
    }, async () => {
      const gate = oneShotGate();
      const rejections = trackUnhandledRejections();
      configureSemanticBackend(makeStubBackend({ dimensions: 8 }));
      __setSemanticRepairPhaseHookForTest(async (phase) => {
        if (phase === pause.phase) {
          await gate.park();
        }
      });
      try {
        await withTwoSqliteDatabases(async (dbs) => {
          const isBackfill = pause.phase === "before-backfill-index-init";
          await dbs.openOld({ deferIndexes: isBackfill, semantic: true });
          const oldGeneration = currentStorageGeneration();
          const reconcile = isBackfill ? reconcileSearchIndexDirtyScope(await dirtyScope()) : null;
          await gate.entered;

          const seeded = await dbs.replaceWithFresh({ semantic: true });
          assert.notEqual(currentStorageGeneration(), oldGeneration, "storage moved to a new generation");
          seedMismatchedVectorTable();
          const seededState = await derivedState();
          const seededVectors = vectorTableState();
          assert.ok(
            seededVectors.tableSql.includes("FLOAT[4] distance_metric=l2"),
            "the seeded table is not 8-wide cosine"
          );
          assert.equal(seededVectors.vecRows.length, 1, "the seeded vector table is populated");

          gate.release();
          if (reconcile) {
            const result = await reconcile;
            assert.equal(result.outcome, "failed", "old reconcile is dropped: not converged, not recontended");
          } else {
            await until(
              () => recordIndexWorkStatsForGenerationForTests(oldGeneration).active === 0,
              "the old job to finish"
            );
            // Let any fire-and-forget tail of the old job settle.
            for (let turn = 0; turn < 5; turn += 1) {
              // biome-ignore lint/performance/noAwaitInLoops: yield a few turns, order matters.
              await new Promise((resolve) => setImmediate(resolve));
            }
          }
          assert.equal(seeded.revision, (await derivedState()).dirty[0]?.revision, "the dirty revision is unchanged");
          assert.deepEqual(
            vectorTableState(),
            seededVectors,
            `old work released from ${pause.phase} rebuilt or wrote the vector table`
          );
          assert.deepEqual(
            await derivedState(),
            seededState,
            `old work released from ${pause.phase} changed derived state`
          );
        });
        assert.deepEqual(rejections.stop(), [], "the old job exits without an unhandled rejection");
      } finally {
        gate.release();
        __setSemanticRepairPhaseHookForTest(null);
        configureSemanticBackend(null);
      }
    });
  }
}

lazyVectorIndexInitTests();

/** A populated vec0 table (4 wide, l2) with its sidecar, meta, progress and snapshot rows, in the CURRENT database. */
function seedMismatchedVectorTable(): void {
  const db = getDb();
  assert.equal(db.vectorIndexKind, "sqlite-vec", "this regression needs the physical vec0 table");
  db.exec(`CREATE VIRTUAL TABLE semantic_search_vec USING vec0(
    connector_instance_id TEXT PARTITION KEY,
    connector_id TEXT,
    scope_key TEXT,
    +record_key TEXT,
    embedding FLOAT[4] distance_metric=l2
  )`);
  const scopeKey = JSON.stringify([STREAM, "subject"]);
  const info = db
    .prepare(
      "INSERT INTO semantic_search_vec(connector_instance_id, connector_id, scope_key, record_key, embedding) VALUES (?, ?, ?, 'k1', ?)"
    )
    .run(INSTANCE_ID, CONNECTOR_ID, scopeKey, Buffer.from(new Float32Array([1, 2, 3, 4]).buffer));
  db.prepare(
    "INSERT INTO semantic_search_rowid(connector_instance_id, connector_id, scope_key, record_key, rowid, input_identity) VALUES (?, ?, ?, 'k1', ?, 'new-identity')"
  ).run(INSTANCE_ID, CONNECTOR_ID, scopeKey, Number(info.lastInsertRowid));
  db.prepare(
    "INSERT INTO semantic_search_meta(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric) VALUES (?, ?, ?, '[]', 'new-model', 4, 'l2')"
  ).run(INSTANCE_ID, CONNECTOR_ID, STREAM);
  db.prepare(
    "INSERT INTO semantic_search_backfill_progress(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric) VALUES (?, ?, ?, '[]', 'new-model', 4, 'l2')"
  ).run(INSTANCE_ID, CONNECTOR_ID, STREAM);
  db.prepare(
    "INSERT INTO semantic_search_snapshots(snapshot_id, query, plan_hash, results_json) VALUES ('new-snapshot', 'q', 'h', '[]')"
  ).run();
}

/** The physical vector table and every sidecar the lazy initialization can delete, from the CURRENT database. */
function vectorTableState() {
  const db = getDb();
  const all = (sql: string) => db.prepare(sql).all();
  return {
    meta: all("SELECT * FROM semantic_search_meta ORDER BY connector_instance_id, stream"),
    progress: all("SELECT * FROM semantic_search_backfill_progress ORDER BY connector_instance_id, stream"),
    rowids: all("SELECT * FROM semantic_search_rowid ORDER BY rowid"),
    snapshots: all("SELECT * FROM semantic_search_snapshots ORDER BY snapshot_id"),
    tableSql: String(
      (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'semantic_search_vec'").get() as
          | { sql?: string }
          | undefined
      )?.sql
    ),
    vecRows: all(
      "SELECT rowid, connector_instance_id, connector_id, scope_key, embedding FROM semantic_search_vec ORDER BY rowid"
    ),
  };
}
