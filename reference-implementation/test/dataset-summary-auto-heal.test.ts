// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  __resetDatasetSummaryAutoHealThrottleForTest,
  __setDatasetSummaryAutoHealNowForTest,
  applyDatasetSummaryRecordDelta,
  ensureDatasetSummaryProjectionHealthy,
  getDatasetSummaryProjection,
  markDatasetSummaryProjectionStale,
  rebuildDatasetSummaryProjection,
} from "../server/dataset-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-auto-heal-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    __resetDatasetSummaryAutoHealThrottleForTest();
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

const healthyDependencies = {
  getCounts: () => ({ connector_count: 1, record_count: 1, stream_count: 1 }),
  getIngestedTimeBounds: () => ({
    earliest: "2026-01-01T00:00:00.000Z",
    latest: "2026-01-01T00:00:00.000Z",
  }),
  getRecordTimeBounds: () => ({ earliest: null, latest: null }),
  getRetainedBytes: () => ({
    blob_bytes: 0,
    record_changes_json_bytes: 0,
    record_json_bytes: 10,
  }),
  listStreamProjectionSeeds: () => [
    {
      connector_id: "gmail",
      record_count: 1,
      record_json_bytes: 10,
      stream: "messages",
    },
  ],
  listTopConnectorCandidates: () => [{ connector_id: "gmail", record_count: 1 }],
};

test("a rebuild of an old stale projection holds a new lease", () =>
  withTempDb(async () => {
    await rebuildDatasetSummaryProjection(healthyDependencies);
    markDatasetSummaryProjectionStale("dropped delta");
    const oldStaleSince = "2026-01-01T00:00:00.000Z";
    getDb()
      .prepare("UPDATE dataset_summary_projection SET metadata_json = json_set(metadata_json, '$.stale_since', ?)")
      .run(oldStaleSince);

    let raced = false;
    await rebuildDatasetSummaryProjection({
      ...healthyDependencies,
      getCounts: () => {
        if (raced) {
          return healthyDependencies.getCounts();
        }
        raced = true;
        applyDatasetSummaryRecordDelta({
          connectorId: "gmail",
          consentTimeField: null,
          dirtyRecordTimeBounds: false,
          emittedAt: oldStaleSince,
          recordChangesJsonBytesDelta: 0,
          recordCountDelta: 1,
          recordJsonBytesDelta: 10,
          stream: "messages",
        });
        const afterDelta = getDatasetSummaryProjection();
        assert.equal(afterDelta.metadata.stale_since, oldStaleSince);
        assert.equal(afterDelta.metadata.rebuild_status, "running");
        assert.equal(afterDelta.counts.record_count, 1, "a live lease defers the delta");
        return healthyDependencies.getCounts();
      },
    });
  }));

test("a read reclaims an expired refresh even when no delta has arrived", () =>
  withTempDb(async () => {
    await rebuildDatasetSummaryProjection(healthyDependencies);
    getDb()
      .prepare(`UPDATE dataset_summary_projection SET metadata_json = json_set(metadata_json,
        '$.rebuild_status', 'running', '$.state', 'refreshing', '$.rebuild_started_at', ?)`)
      .run(new Date(Date.now() - 6 * 60_000).toISOString());

    const healed = await ensureDatasetSummaryProjectionHealthy(healthyDependencies);
    assert.equal(healed.metadata.state, "fresh");
    assert.equal(healed.metadata.rebuild_status, "idle");
  }));

test("a read makes one rebuild pass and a conflict consumes cooldown without clearing earlier failures", () =>
  withTempDb(async () => {
    let now = 0;
    __setDatasetSummaryAutoHealNowForTest(() => now);
    let failedReads = 0;
    const failing = {
      ...healthyDependencies,
      getCounts: () => {
        failedReads += 1;
        throw new Error("dependency failed");
      },
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each read models a separate retry after cooldown.
      await ensureDatasetSummaryProjectionHealthy(failing);
      now += 60_000;
    }
    assert.equal(failedReads, 4);

    let conflictingReads = 0;
    const conflicting = {
      ...healthyDependencies,
      getCounts: () => {
        conflictingReads += 1;
        markDatasetSummaryProjectionStale("concurrent delta");
        return healthyDependencies.getCounts();
      },
    };
    const result = await ensureDatasetSummaryProjectionHealthy(conflicting);
    assert.equal(result.metadata.state, "stale");
    assert.equal(conflictingReads, 1);
    await ensureDatasetSummaryProjectionHealthy(conflicting);
    assert.equal(conflictingReads, 1, "the next read is inside cooldown");

    now += 60_000;
    await ensureDatasetSummaryProjectionHealthy(failing);
    assert.equal(failedReads, 5, "cooldown expired");
    now += 60_000;
    await ensureDatasetSummaryProjectionHealthy(failing);
    assert.equal(failedReads, 5, "the conflict did not reset the failure streak");
  }));

/**
 * Reproduces the owner's exact reported shape: a fresh SQLite database has
 * never had `rebuildDatasetSummaryProjection` called (its one and only
 * caller was a hidden owner-authenticated HTTP route). Before the fix,
 * nothing ever calls that function without a human hitting the route --
 * `getDatasetSummaryProjection()` on an empty table just returns the
 * "rebuilding" placeholder forever. This asserts the read-path auto-heal
 * converges it without any human action.
 */
test("a never-converged projection converges without any human action", () =>
  withTempDb(async () => {
    const before = getDatasetSummaryProjection();
    assert.equal(before.metadata.computed_at, null, "precondition: projection has never converged");

    const healed = await ensureDatasetSummaryProjectionHealthy(healthyDependencies);

    assert.equal(healed.metadata.state, "fresh");
    assert.equal(healed.metadata.rebuild_status, "idle");
    assert.ok(healed.metadata.computed_at, "expected computed_at to be set after auto-heal");

    const persisted = getDatasetSummaryProjection();
    assert.equal(persisted.metadata.state, "fresh");
    assert.ok(persisted.metadata.computed_at);
  }));

/**
 * Thrash bound: a rebuild that fails for a durable reason (bad dependency,
 * corrupt data, a bug) must not retry on every single read forever --
 * burning a full-table scan's worth of CPU on a 456k-record instance every
 * time the dashboard polls. After MAX_CONSECUTIVE_FAILURES auto-heal
 * attempts, it must stop retrying and the projection must report `failed`
 * honestly, never `fresh` -- auto-retry must not become auto-lie.
 */
test("a rebuild that fails repeatedly stops retrying and reports failed, never fresh", () =>
  withTempDb(async () => {
    let now = 0;
    __setDatasetSummaryAutoHealNowForTest(() => now);

    const failingDependencies = {
      ...healthyDependencies,
      getCounts: () => {
        throw new Error("simulated durable dependency failure");
      },
    };

    let attempts = 0;
    const ATTEMPTS_TO_DRIVE = 10;
    for (let i = 0; i < ATTEMPTS_TO_DRIVE; i += 1) {
      attempts += 1;
      // biome-ignore lint/performance/noAwaitInLoops: sequential reads model successive GET /_ref/dataset/summary polls
      await ensureDatasetSummaryProjectionHealthy(failingDependencies);
      // Advance past the cooldown floor between every simulated read so the
      // loop is testing the failure CAP, not the cooldown timer.
      now += 60_000;
    }

    const afterManyFailures = getDatasetSummaryProjection();
    assert.equal(afterManyFailures.metadata.state, "failed");
    assert.notEqual(afterManyFailures.metadata.state, "fresh");
    assert.ok(afterManyFailures.metadata.last_error);

    // A rebuild call count below the number of simulated reads proves the
    // cap actually stopped new attempts rather than merely reporting
    // failure on an unbounded retry.
    assert.ok(attempts > 1, "expected more than one simulated read so the cap has room to engage before the loop ends");
  }));

/**
 * A converged (fresh) projection must not be rebuilt on every read --
 * that would turn a cheap dashboard GET into a full-table scan on every
 * poll. `ensureDatasetSummaryProjectionHealthy` must be a no-op once the
 * projection has already converged.
 */
test("a converged projection is not needlessly rebuilt", () =>
  withTempDb(async () => {
    await rebuildDatasetSummaryProjection(healthyDependencies);
    const freshBefore = getDatasetSummaryProjection();
    assert.equal(freshBefore.metadata.state, "fresh");

    let rebuildDependencyCalls = 0;
    const countingDependencies = {
      ...healthyDependencies,
      getCounts: () => {
        rebuildDependencyCalls += 1;
        return healthyDependencies.getCounts();
      },
    };

    const result = await ensureDatasetSummaryProjectionHealthy(countingDependencies);

    assert.equal(rebuildDependencyCalls, 0, "expected no rebuild dependency calls against an already-fresh projection");
    assert.equal(result.metadata.state, "fresh");
    assert.equal(result.metadata.computed_at, freshBefore.metadata.computed_at);
  }));

/**
 * Auto-heal must not fight a live rebuild that is already in flight
 * (whether started by a concurrent auto-heal call or the owner's manual
 * rebuild action). It reuses the same lease-awareness the lease-expiry fix
 * already added (`isRebuildLeaseActive`) rather than inventing a second
 * concurrency mechanism.
 */
test("auto-heal does not start a second rebuild while one is already in flight", () =>
  withTempDb(async () => {
    // Simulate an in-flight rebuild: rebuild_status 'running', lease fresh.
    const db = getDb();
    db.prepare(
      `INSERT INTO dataset_summary_projection(projection_key, summary_json, metadata_json, updated_at, generation)
       VALUES('global', ?, ?, ?, 1)
       ON CONFLICT(projection_key) DO UPDATE SET
         summary_json = excluded.summary_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at,
         generation = excluded.generation`
    ).run(
      JSON.stringify({
        counts: { connector_count: 0, record_count: 0, stream_count: 0 },
        ingested_time_bounds: { earliest: null, latest: null },
        record_time_bounds: { earliest: null, latest: null },
        retained_bytes: { blob_bytes: 0, record_changes_json_bytes: 0, record_json_bytes: 0 },
        top_connector_candidates: [],
      }),
      JSON.stringify({
        computed_at: null,
        last_error: null,
        rebuild_started_at: new Date().toISOString(),
        rebuild_status: "running",
        source_high_watermark: null,
        stale_since: new Date().toISOString(),
        state: "rebuilding",
      }),
      new Date().toISOString()
    );

    let rebuildDependencyCalls = 0;
    const countingDependencies = {
      ...healthyDependencies,
      getCounts: () => {
        rebuildDependencyCalls += 1;
        return healthyDependencies.getCounts();
      },
    };

    const result = await ensureDatasetSummaryProjectionHealthy(countingDependencies);

    assert.equal(rebuildDependencyCalls, 0, "expected auto-heal to defer to the already-live rebuild lease");
    assert.equal(result.metadata.rebuild_status, "running");
    applyDatasetSummaryRecordDelta({
      connectorId: "gmail",
      consentTimeField: null,
      dirtyRecordTimeBounds: false,
      emittedAt: "2026-01-01T00:00:00.000Z",
      recordChangesJsonBytesDelta: 0,
      recordCountDelta: 1,
      recordJsonBytesDelta: 10,
      stream: "messages",
    });
  }));
