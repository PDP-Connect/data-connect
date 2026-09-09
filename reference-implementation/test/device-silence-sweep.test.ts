// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the server-side silence detector.
 *
 * A local collector is a one-shot process a host supervisor invokes on a timer.
 * When it stops starting at all, no run fails and no error is reported, because
 * the process dies before it makes any network call. The only thing the server
 * can observe is that heartbeats stop arriving.
 *
 * Every test runs against the REAL attention store and real device rows. An
 * earlier revision used an in-memory attention fake whose upsert preserved
 * lifecycle and notification state; the real store's `ON CONFLICT ... DO UPDATE`
 * overwrites both, so the fake asserted the opposite of the shipped behaviour
 * and hid two defects.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { getDefaultConnectorAttentionStore } from "../server/stores/connector-attention-store.ts";
import { getDefaultDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import {
  createDeviceSilenceStage,
  DEVICE_SILENCE_REASON_CODE,
  DEVICE_SILENT_ESCALATION_MS,
  deviceSilenceAttentionId,
} from "../server/stores/device-silence-stage.ts";

const NOW = "2026-05-19T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function isoAgo(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

const SILENT_AT = isoAgo(DEVICE_SILENT_ESCALATION_MS * 2);

/**
 * Seed real device and source-instance rows, with a real heartbeat write when
 * the instance is meant to have checked in. Everything goes through the
 * production store, so the silence query is exercised as shipped.
 */
async function seed(
  rows: ReadonlyArray<{
    connectorId?: string;
    deviceId?: string;
    deviceStatus?: string;
    heartbeatAt?: string | null;
    sourceInstanceId: string;
  }>
) {
  const store = getDefaultDeviceExporterStore();
  const createdAt = isoAgo(DEVICE_SILENT_ESCALATION_MS * 3);
  const devices = new Set<string>();
  for (const row of rows) {
    const deviceId = row.deviceId ?? "dev_1";
    if (!devices.has(deviceId)) {
      devices.add(deviceId);
      await store.createDevice({
        createdAt,
        deviceId,
        displayName: deviceId,
        ownerSubjectId: "owner_local",
        status: row.deviceStatus ?? "active",
        updatedAt: createdAt,
      });
    }
    await store.upsertSourceInstance({
      connectorId: row.connectorId ?? "claude_code",
      createdAt,
      deviceId,
      localBindingId: row.sourceInstanceId,
      sourceInstanceId: row.sourceInstanceId,
      updatedAt: createdAt,
    });
    const heartbeatAt = row.heartbeatAt === undefined ? SILENT_AT : row.heartbeatAt;
    if (heartbeatAt !== null) {
      await store.markSourceInstanceHeartbeat(deviceId, row.sourceInstanceId, {
        receivedAt: heartbeatAt,
        recordsPending: 0,
        status: "healthy",
      });
    }
  }
}

/**
 * Record a delivery outcome for everything a tick opened, which is what the
 * notifier does in production. The query keeps an episode selected until some
 * outcome exists, so a stage driven with no notifier attached would keep
 * re-offering the same rows — correctly, since nobody has been told.
 */
async function markDelivered(result: { opened: ReadonlyArray<{ attentionId: string }> }) {
  const attentionStore = getDefaultConnectorAttentionStore();
  for (const entry of result.opened) {
    await attentionStore.recordNotificationOutcomeById({
      attentionId: entry.attentionId,
      outcome: "sent",
      reason: null,
    });
  }
}

function withDb(fn: () => Promise<void>) {
  return async () => {
    initDb(":memory:");
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

test(
  "a collector quiet past the escalation threshold opens one attention record",
  withDb(async () => {
    await seed([{ sourceInstanceId: "dsi_1" }]);
    const result = await createDeviceSilenceStage().run({ nowIso: NOW });

    assert.equal(result.detected, 1);
    assert.equal(result.opened.length, 1);

    const stored = await getDefaultConnectorAttentionStore().getAttentionById(
      deviceSilenceAttentionId("dsi_1", SILENT_AT)
    );
    assert.ok(stored, "the record is durable, not just reported");
    assert.equal(stored.reason_code, DEVICE_SILENCE_REASON_CODE);
    assert.equal(stored.lifecycle, "open");
    assert.equal(stored.auto_detect, true, "no human asked for this; the sweep found it");
  })
);

test(
  "a collector quiet for less than the escalation threshold is left alone",
  withDb(async () => {
    // Just inside the threshold. The heartbeat is already far past the 30-minute
    // lease, so every presentation surface calls it stale — but staleness is the
    // machine-timescale question and this is the human one. A laptop closed
    // overnight lands here, and waking someone for it is how a threshold stops
    // being read.
    await seed([{ heartbeatAt: isoAgo(DEVICE_SILENT_ESCALATION_MS - 60_000), sourceInstanceId: "dsi_1" }]);
    const result = await createDeviceSilenceStage().run({ nowIso: NOW });

    assert.equal(result.detected, 0);
    assert.equal(result.opened.length, 0);
  })
);

test(
  "a reported collector is not reported again, however many ticks pass",
  withDb(async () => {
    // Once the owner has been told, the query stops selecting this episode, so
    // the next tick simply does not see the row. That is what makes a
    // level-triggered sweep safe to run every 60 seconds without a cursor, a
    // wrap rule, or any state carried between ticks.
    await seed([{ sourceInstanceId: "dsi_1" }]);
    const stage = createDeviceSilenceStage();

    const first = await stage.run({ nowIso: NOW });
    assert.equal(first.opened.length, 1);
    await markDelivered(first);

    for (let tick = 1; tick <= 50; tick += 1) {
      const later = await stage.run({ nowIso: new Date(NOW_MS + tick * 60_000).toISOString() });
      assert.equal(later.detected, 0, "an already-reported episode is not selected again");
      assert.equal(later.opened.length, 0);
    }
  })
);

test(
  "a record the owner resolved is not reopened while the collector stays silent",
  withDb(async () => {
    // Resolving a notice does not restart the collector, so the instance stays
    // silent forever. Re-opening it would produce a notice that returns within a
    // minute and cannot be dismissed. The query does not filter on lifecycle, so
    // a resolved record suppresses exactly as an open one does.
    await seed([{ sourceInstanceId: "dsi_1" }]);
    const attentionStore = getDefaultConnectorAttentionStore();
    const stage = createDeviceSilenceStage();
    await markDelivered(await stage.run({ nowIso: NOW }));

    const attentionId = deviceSilenceAttentionId("dsi_1", SILENT_AT);
    await attentionStore.transitionAttention({ attentionId, to: "resolved" });

    const second = await stage.run({ nowIso: new Date(NOW_MS + 60_000).toISOString() });
    assert.equal(second.detected, 0, "the resolved record keeps this episode out of the query");
    assert.equal((await attentionStore.getAttentionById(attentionId))?.lifecycle, "resolved");
  })
);

test(
  "a collector that recovers and then goes silent again raises a second notice",
  withDb(async () => {
    // Silence is a property of an interval, not of an instance. The record id
    // embeds the heartbeat the silence followed, so a later outage is a different
    // episode: the query's exclusion does not match it, and it opens as a new
    // record while the resolved one stays resolved.
    await seed([{ sourceInstanceId: "dsi_1" }]);
    const attentionStore = getDefaultConnectorAttentionStore();
    const stage = createDeviceSilenceStage();

    const first = await stage.run({ nowIso: NOW });
    assert.equal(first.opened.length, 1);
    await markDelivered(first);
    const firstEpisodeId = deviceSilenceAttentionId("dsi_1", SILENT_AT);
    await attentionStore.transitionAttention({ attentionId: firstEpisodeId, to: "resolved" });

    // A real heartbeat lands: the collector ran again.
    const recoveredAt = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
    await getDefaultDeviceExporterStore().markSourceInstanceHeartbeat("dev_1", "dsi_1", {
      receivedAt: recoveredAt,
      recordsPending: 0,
      status: "healthy",
    });

    // While healthy, nothing is raised.
    const healthy = await stage.run({ nowIso: new Date(Date.parse(recoveredAt) + 60_000).toISOString() });
    assert.equal(healthy.detected, 0, "a collector that just checked in is not silent");

    // Then it goes quiet again.
    const laterNow = new Date(Date.parse(recoveredAt) + DEVICE_SILENT_ESCALATION_MS * 2).toISOString();
    const second = await stage.run({ nowIso: laterNow });

    assert.equal(second.opened.length, 1, "the new outage is announced");
    await markDelivered(second);
    const secondEpisodeId = deviceSilenceAttentionId("dsi_1", recoveredAt);
    assert.notEqual(secondEpisodeId, firstEpisodeId);
    assert.equal((await attentionStore.getAttentionById(secondEpisodeId))?.lifecycle, "open");
    assert.equal(
      (await attentionStore.getAttentionById(firstEpisodeId))?.lifecycle,
      "resolved",
      "and the notice the owner already dealt with stays dealt with"
    );

    // Repeated ticks within the new episode stay quiet.
    const third = await stage.run({ nowIso: new Date(Date.parse(laterNow) + 60_000).toISOString() });
    assert.equal(third.detected, 0);
  })
);

test(
  "a fleet larger than one batch is fully handled across ticks, with no instance starved",
  withDb(async () => {
    // The batch bound is the only thing limiting a tick, and it is sufficient:
    // handling a row writes the record that removes it from the next tick's
    // results, so the remaining work shrinks monotonically. 450 instances at a
    // cap of 200 completes in three ticks with nothing left behind — no cursor,
    // no wrap, no position to persist.
    const total = 450;
    await seed(
      Array.from({ length: total }, (_unused, index) => ({
        sourceInstanceId: `dsi_${String(index).padStart(4, "0")}`,
      }))
    );
    const stage = createDeviceSilenceStage();

    const detected: number[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      const result = await stage.run({ maxInstances: 200, nowIso: new Date(NOW_MS + tick * 60_000).toISOString() });
      await markDelivered(result);
      detected.push(result.detected);
    }
    assert.deepEqual(detected, [200, 200, 50, 0], "each tick takes a bounded bite and the backlog drains to nothing");

    const attentionStore = getDefaultConnectorAttentionStore();
    for (const index of [0, 199, 200, 399, total - 1]) {
      const id = deviceSilenceAttentionId(`dsi_${String(index).padStart(4, "0")}`, SILENT_AT);
      assert.ok(await attentionStore.getAttentionById(id), `instance ${index} was reached`);
    }
  })
);

test(
  "a restart between ticks neither re-reports nor loses progress",
  withDb(async () => {
    // Nothing is carried in the process, so there is nothing a restart can lose.
    // The database holds the whole answer: records already written exclude their
    // instances, and everything else is still selected.
    const total = 450;
    await seed(
      Array.from({ length: total }, (_unused, index) => ({
        sourceInstanceId: `dsi_${String(index).padStart(4, "0")}`,
      }))
    );

    const first = await createDeviceSilenceStage().run({ maxInstances: 200, nowIso: NOW });
    assert.equal(first.detected, 200);
    await markDelivered(first);

    // A brand new stage, as after a deploy.
    const afterRestart = await createDeviceSilenceStage().run({
      maxInstances: 200,
      nowIso: new Date(NOW_MS + 60_000).toISOString(),
    });
    assert.equal(afterRestart.detected, 200, "it resumes on unreported work rather than re-reading the first batch");

    const openedIds = new Set(afterRestart.opened.map((entry) => entry.attentionId));
    assert.ok(
      !openedIds.has(deviceSilenceAttentionId("dsi_0000", SILENT_AT)),
      "the instance handled before the restart is not handled again"
    );
  })
);

test(
  "a cap above the store's own row ceiling still makes progress",
  withDb(async () => {
    // The store clamps every read to the row ceiling its query artifact declares,
    // so a caller asking for more than that gets a full page rather than the page
    // it asked for. Nothing compares those two numbers, so the mismatch cannot
    // matter — the batch is whatever the store returned, and progress comes from
    // those rows leaving the result set.
    const total = 2100; // above the artifact's declared @max_rows of 2048
    await seed(
      Array.from({ length: total }, (_unused, index) => ({
        sourceInstanceId: `dsi_${String(index).padStart(4, "0")}`,
      }))
    );
    const stage = createDeviceSilenceStage();

    const first = await stage.run({ maxInstances: 5000, nowIso: NOW });
    assert.equal(first.detected, 2048, "clamped to the ceiling, and the read does not throw");
    await markDelivered(first);

    const second = await stage.run({ maxInstances: 5000, nowIso: new Date(NOW_MS + 60_000).toISOString() });
    assert.equal(second.detected, total - 2048, "the remainder arrives next tick");

    const tailId = deviceSilenceAttentionId(`dsi_${String(total - 1).padStart(4, "0")}`, SILENT_AT);
    assert.ok(await getDefaultConnectorAttentionStore().getAttentionById(tailId), "the tail of the fleet is reached");
  })
);

test(
  "the query excludes instances that never checked in and those on revoked devices",
  withDb(async () => {
    await seed([
      { sourceInstanceId: "dsi_silent" },
      // Never spoke: unfinished enrollment, not a collector that went quiet.
      { connectorId: "codex", heartbeatAt: null, sourceInstanceId: "dsi_never" },
      // Owner turned this device off; its silence is intentional.
      { deviceId: "dev_revoked", deviceStatus: "revoked", sourceInstanceId: "dsi_on_revoked" },
    ]);

    const result = await createDeviceSilenceStage().run({ nowIso: NOW });

    assert.equal(result.detected, 1);
    assert.equal(result.opened[0]?.attentionId, deviceSilenceAttentionId("dsi_silent", SILENT_AT));
  })
);

test(
  "the id the query rebuilds in SQL matches the one the writer builds",
  withDb(async () => {
    // The query excludes already-reported instances by reconstructing the
    // attention id from the row's own heartbeat. If the two string builders ever
    // drift, the exclusion silently stops matching and every silent collector is
    // reported on every tick. Seeding, reporting, then asserting the instances
    // disappear from the query is what pins them together.
    const oddTimestamps = ["2026-05-01T00:00:00.000Z", "2026-01-09T23:59:59.999Z", "2026-11-30T07:05:03.010Z"];
    await seed(oddTimestamps.map((heartbeatAt, index) => ({ heartbeatAt, sourceInstanceId: `dsi_ts_${index}` })));
    const stage = createDeviceSilenceStage();
    const laterNow = "2026-12-31T00:00:00.000Z";

    const first = await stage.run({ nowIso: laterNow });
    assert.equal(first.detected, oddTimestamps.length, "all three are silent and unreported");
    await markDelivered(first);

    const second = await stage.run({ nowIso: laterNow });
    assert.equal(
      second.detected,
      0,
      "and all three are excluded afterwards, which only holds if SQL and TypeScript build the same id"
    );
  })
);

test(
  "an owner decision made before delivery succeeds is never overwritten",
  withDb(async () => {
    // The stage upserts a freshly-built `open` record, so any row the query still
    // returns has its lifecycle reset. That is only safe while the owner has not
    // touched it. This is reachable in one step: a notifier that fails before
    // handing the push over records no outcome, leaving a visible but unstamped
    // notice the owner can act on before the next tick.
    const attentionStore = getDefaultConnectorAttentionStore();

    for (const state of ["resolved", "cancelled", "acknowledged", "in_progress"] as const) {
      initDb(":memory:");
      try {
        const sourceInstanceId = `dsi_${state}`;
        await seed([{ sourceInstanceId }]);
        const stage = createDeviceSilenceStage();

        // First tick opens the notice; nothing stamps it, as after a failed send.
        const first = await stage.run({ nowIso: NOW });
        assert.equal(first.opened.length, 1);
        const attentionId = deviceSilenceAttentionId(sourceInstanceId, SILENT_AT);
        assert.equal(
          (await attentionStore.getAttentionById(attentionId))?.notification_updated_at,
          null,
          "no delivery was recorded"
        );

        // The owner acts on the unstamped notice.
        await attentionStore.transitionAttention({ attentionId, to: state });

        const second = await stage.run({ nowIso: new Date(NOW_MS + 60_000).toISOString() });
        assert.equal(second.detected, 0, `a ${state} notice is not selected again`);
        assert.equal(
          (await attentionStore.getAttentionById(attentionId))?.lifecycle,
          state,
          `a ${state} notice keeps the owner's decision rather than being reset to open`
        );
      } finally {
        closeDb();
      }
    }
  })
);

test(
  "persistently failing retries never monopolise the batch",
  withDb(async () => {
    // The notifier leaves a record unstamped when it fails before handing the
    // push over, so the row stays selected in order to be retried. Correlated
    // failures — an expired push credential, an unreachable endpoint — hit every
    // instance at once, so without ordering, `cap` concurrent retries fill every
    // subsequent batch and nothing behind them is ever reached.
    const total = 450;
    await seed(
      Array.from({ length: total }, (_unused, index) => ({
        sourceInstanceId: `dsi_${String(index).padStart(4, "0")}`,
      }))
    );
    const stage = createDeviceSilenceStage();

    const seen = new Set<string>();
    for (let tick = 0; tick < 6; tick += 1) {
      // No markDelivered anywhere: every push fails before delivery, on every
      // tick, for every instance.
      const result = await stage.run({
        maxInstances: 200,
        nowIso: new Date(NOW_MS + tick * 60_000).toISOString(),
      });
      for (const entry of result.opened) {
        seen.add(entry.attentionId);
      }
    }

    assert.equal(seen.size, total, "every instance is reached even though no push ever succeeds");
  })
);

test(
  "a fleet where the first batch always fails still reaches the collectors behind it",
  withDb(async () => {
    // The sign-off's fixture: 200 instances whose delivery consistently fails,
    // ordered ahead of one healthy instance. Before the ordering fix the healthy
    // 201st never received a record on any tick.
    const failing = 200;
    await seed([
      ...Array.from({ length: failing }, (_unused, index) => ({
        sourceInstanceId: `dsi_fail_${String(index).padStart(4, "0")}`,
      })),
      { sourceInstanceId: "dsi_healthy" },
    ]);
    const stage = createDeviceSilenceStage();

    // Tick 1 takes the first batch and records nothing for it.
    const first = await stage.run({ maxInstances: failing, nowIso: NOW });
    assert.equal(first.detected, failing);

    // Tick 2 must spend its budget on the instance nobody has been told about.
    const second = await stage.run({ maxInstances: failing, nowIso: new Date(NOW_MS + 60_000).toISOString() });
    const healthyId = deviceSilenceAttentionId("dsi_healthy", SILENT_AT);
    assert.ok(
      second.opened.some((entry) => entry.attentionId === healthyId),
      "a never-reported collector is reached ahead of rows already carrying a record"
    );
  })
);
