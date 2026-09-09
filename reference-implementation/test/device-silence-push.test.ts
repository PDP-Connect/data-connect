// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the silent-collector push.
 *
 * The load-bearing test here is the seven-day one. The sweep that drives this
 * notifier is level-triggered — it re-observes the same silent collector on
 * every 60-second tick — so the entire justification for building a durable edge
 * trigger instead of calling the push helper directly is that the direct call
 * would send 1,440 notifications a day, forever, per device.
 *
 * Everything runs against the REAL attention store on an in-memory SQLite
 * database. Only the device roster and the push sender are stubbed: the roster
 * because seeding heartbeats is orthogonal, and the sender because no test may
 * put a notification on the network. An earlier revision used an in-memory
 * attention fake whose upsert preserved lifecycle and notification state; the
 * real store overwrites both, so the fake proved the opposite of the shipped
 * behaviour.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { notifyDeviceSilenceOpened } from "../server/device-silence-notifier.ts";
import { getDefaultConnectorAttentionStore } from "../server/stores/connector-attention-store.ts";
import { getDefaultDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import {
  createDeviceSilenceStage,
  DEVICE_SILENT_ESCALATION_MS,
  deviceSilenceAttentionId,
} from "../server/stores/device-silence-stage.ts";
import { buildEscalationPushPayload, type WebPushConfig } from "../server/web-push-notifications.ts";

const NOW_MS = Date.parse("2026-05-19T12:00:00.000Z");
const SWEEP_INTERVAL_MS = 60_000;
const SEVEN_DAYS_OF_TICKS = (7 * 24 * 60 * 60 * 1000) / SWEEP_INTERVAL_MS; // 10,080

/** The heartbeat the fixture went silent after; the attention id embeds it. */
const SILENT_AT = new Date(NOW_MS - DEVICE_SILENT_ESCALATION_MS * 2).toISOString();

/** VAPID placeholders. The sender is stubbed, so no key is ever used. */
const CONFIG: WebPushConfig = {
  enabled: true,
  privateKey: "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
  publicKey: "BAabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcd",
  subject: "mailto:test@example.invalid",
  unavailableReason: null,
};

interface SentPush {
  connectionUrl: string;
  connectorDisplayName: string;
  reason: string;
}

/**
 * The whole stage-plus-notifier pipeline against the real durable store, with a
 * stubbed sender that records every dispatch.
 */
async function seedSilentDevice() {
  const store = getDefaultDeviceExporterStore();
  const createdAt = new Date(NOW_MS - DEVICE_SILENT_ESCALATION_MS * 3).toISOString();
  await store.createDevice({
    createdAt,
    deviceId: "dev_1",
    displayName: "dev_1",
    ownerSubjectId: "owner_local",
    updatedAt: createdAt,
  });
  await store.upsertSourceInstance({
    connectorId: "claude_code",
    createdAt,
    deviceId: "dev_1",
    localBindingId: "dsi_1",
    sourceInstanceId: "dsi_1",
    updatedAt: createdAt,
  });
  await store.markSourceInstanceHeartbeat("dev_1", "dsi_1", {
    receivedAt: SILENT_AT,
    recordsPending: 41,
    status: "healthy",
  });
}

/**
 * The whole stage-plus-notifier pipeline against real stores, with a stubbed
 * sender that records every dispatch. Nothing about which instances are silent
 * or already handled is faked — that is the query's job now.
 */
function harness() {
  const pushes: SentPush[] = [];
  const attentionStore = getDefaultConnectorAttentionStore();
  const stage = createDeviceSilenceStage();

  // Set by a test to make the next display-name lookup reject once, modelling a
  // transient failure in the connector-summary read the production notifier does
  // before it sends. That lookup can fail without the process dying, and the
  // sweep swallows the error, so nothing is stamped on the record.
  let failNextLookup = false;

  async function tick(nowMs: number, quietWindow?: Record<string, unknown>) {
    const result = await stage.run({ nowIso: new Date(nowMs).toISOString() });
    if (result.opened.length === 0) {
      return 0;
    }
    return await notifyDeviceSilenceOpened(result, {
      config: CONFIG,
      connectorDisplayName: () => {
        if (failNextLookup) {
          failNextLookup = false;
          throw new Error("transient connector-summary lookup failure");
        }
        return "Claude Code";
      },
      now: () => new Date(nowMs),
      ownerSubjectId: "owner_local",
      ...(quietWindow ? { quietWindow: quietWindow as never } : {}),
      sendEscalationPush: ((args: SentPush) => {
        pushes.push({
          connectionUrl: args.connectionUrl,
          connectorDisplayName: args.connectorDisplayName,
          reason: args.reason,
        });
        return Promise.resolve({ attempted: 1, sent: 1, unavailable: false });
      }) as never,
    });
  }

  return {
    attentionStore,
    failNextLookupOnce: () => {
      failNextLookup = true;
    },
    pushes,
    tick,
  };
}

function withRealStore(fn: (ctx: ReturnType<typeof harness>) => Promise<void>) {
  return async () => {
    initDb(":memory:");
    try {
      await seedSilentDevice();
      await fn(harness());
    } finally {
      closeDb();
    }
  };
}

test(
  "a device overdue for seven days across 10,080 sweep ticks sends exactly one push",
  withRealStore(async ({ pushes, tick }) => {
    // This is the whole justification for the edge trigger. The sweep is
    // level-triggered at 60 seconds; a push issued from the tick would be 1,440
    // notifications a day, per device, for as long as the collector stayed down.
    assert.equal(SEVEN_DAYS_OF_TICKS, 10_080, "one week of 60-second ticks");
    for (let index = 0; index < SEVEN_DAYS_OF_TICKS; index += 1) {
      await tick(NOW_MS + index * SWEEP_INTERVAL_MS);
    }

    assert.equal(pushes.length, 1, "a week of continuous silence is one notification, not 10,080");
  })
);

test(
  "the push carries only the connector display name as free text",
  withRealStore(async ({ pushes, tick }) => {
    // Push bodies render on a lock screen before the owner authenticates. The
    // fixture's device is named "tim-laptop" and is holding 41 pending records;
    // neither may appear, because a lock screen is visible to anyone holding the
    // phone.
    await tick(NOW_MS);

    assert.equal(pushes.length, 1);
    const [push] = pushes;
    assert.equal(push?.connectorDisplayName, "Claude Code");

    // Built with the SAME connectionUrl production sends, so the assertions
    // below cover the shipped payload rather than a default-argument variant.
    const payload = buildEscalationPushPayload({
      connectionUrl: push?.connectionUrl ?? "",
      connectorDisplayName: push?.connectorDisplayName ?? "",
      reason: "needs_attention",
    });
    assert.equal(payload.title, "PDPP Claude Code: action needed");
    assert.equal(payload.body, "Your attention is required to continue syncing.", "body is fixed copy");

    // Assert over the human-visible fields, not the whole serialized object: the
    // payload's ISO timestamp contains arbitrary digits, so a bare search for
    // "41" matches a clock reading rather than the record count and would fail
    // for a reason that has nothing to do with disclosure.
    const visible = `${payload.title} ${payload.body}`;
    assert.doesNotMatch(visible, /tim-laptop/, "no device name or hostname");
    assert.doesNotMatch(visible, /dsi_1|dev_1/, "no device or source-instance identifiers");
    assert.doesNotMatch(visible, /\d/, "no counts, paths, or other digits reach the lock screen at all");

    // The url is not rendered on the lock screen, but it is part of the payload,
    // so pin what it may carry: a connector-instance id for routing, and none of
    // the device-identifying fields the record's metadata holds.
    assert.match(payload.url, /^\/sources\/cin_[0-9a-f]+$/, "a routing path to the connector instance");
    assert.doesNotMatch(payload.url, /tim-laptop|dsi_1|dev_1/, "the route carries no device identity");
  })
);

test(
  "delivery is stamped durably on the attention record and survives later ticks",
  withRealStore(async ({ attentionStore, pushes, tick }) => {
    await tick(NOW_MS);

    const attentionId = deviceSilenceAttentionId("dsi_1", SILENT_AT);
    assert.equal(
      (await attentionStore.getAttentionById(attentionId))?.notification_state,
      "sent",
      "the record itself records that the owner was told"
    );
    assert.equal(pushes.length, 1);

    await tick(NOW_MS + SWEEP_INTERVAL_MS);
    assert.equal(
      (await attentionStore.getAttentionById(attentionId))?.notification_state,
      "sent",
      "and the next tick's rewrite of the record does not reset it"
    );
    assert.equal(pushes.length, 1);
  })
);

test("a restart between ticks does not re-send, because the dedupe is in the database", async () => {
  // Throw away every in-process object between the two ticks and rebuild from
  // the same database. Nothing is carried in memory, so the recorded delivery
  // outcome is the only thing that can suppress the second send — and it does.
  initDb(":memory:");
  try {
    await seedSilentDevice();
    const before = harness();
    await before.tick(NOW_MS);
    assert.equal(before.pushes.length, 1);

    const after = harness();
    await after.tick(NOW_MS + SWEEP_INTERVAL_MS);
    assert.equal(after.pushes.length, 0, "the recorded outcome is what survives the restart");
  } finally {
    closeDb();
  }
});

test(
  "a resolved notice is not reopened, and does not push again while the collector stays silent",
  withRealStore(async ({ attentionStore, pushes, tick }) => {
    // Resolving a notice does not restart the collector, so the instance stays
    // in the silence query forever. Re-opening it would produce a notice the
    // owner cannot dismiss AND a fresh push on every tick — the exact condition
    // the exactly-one-push test exists to prevent, reached by a different path.
    await tick(NOW_MS);
    assert.equal(pushes.length, 1);

    const attentionId = deviceSilenceAttentionId("dsi_1", SILENT_AT);
    await attentionStore.transitionAttention({ attentionId, to: "resolved" });

    for (let index = 1; index <= 100; index += 1) {
      await tick(NOW_MS + index * SWEEP_INTERVAL_MS);
    }

    assert.equal(pushes.length, 1, "a resolved notice stays resolved and silent");
    assert.equal((await attentionStore.getAttentionById(attentionId))?.lifecycle, "resolved");
  })
);

test(
  "a quiet window suppresses the push and records why, rather than dropping it silently",
  withRealStore(async ({ attentionStore, pushes, tick }) => {
    // Classified INFORMATIONAL so quiet hours actually apply: the
    // action-required tier is never quiet-suppressed by design, and a collector
    // quiet for a day is not made worse by waiting until morning.
    await tick(NOW_MS, { enabled: true, end: "23:59", start: "00:00", timeZone: "UTC" });

    assert.equal(pushes.length, 0, "no push inside the quiet window");
    const stored = await attentionStore.getAttentionById(deviceSilenceAttentionId("dsi_1", SILENT_AT));
    assert.equal(stored?.notification_state, "suppressed");
    assert.equal(stored?.notification_reason, "quiet_hours");
  })
);

test(
  "a transient failure before sending does not consume the notice; a later tick still delivers it",
  withRealStore(async ({ attentionStore, failNextLookupOnce, pushes, tick }) => {
    // The production notifier resolves a connector display name before it sends,
    // and that lookup reads through the server's connector-summary path, which
    // can reject transiently. The sweep catches and logs, so the process keeps
    // running with nothing recorded on the record — no delivery was attempted,
    // so the owner has not been told.
    //
    // The same stage and the same process are kept alive throughout, because
    // that is the case that broke: reconstructing the stage would rebuild any
    // in-memory bookkeeping and hide the defect.
    const attentionId = deviceSilenceAttentionId("dsi_1", SILENT_AT);

    failNextLookupOnce();
    await tick(NOW_MS);

    assert.equal(pushes.length, 0, "the lookup failed, so nothing was sent");
    const afterFailure = await attentionStore.getAttentionById(attentionId);
    assert.equal(afterFailure?.lifecycle, "open", "the notice exists and is open");
    assert.equal(afterFailure?.notification_state, "pending");
    assert.equal(afterFailure?.notification_updated_at, null, "no outcome was recorded, so no attempt is on record");

    // Later ticks in the SAME process must still deliver it. An edge that was
    // offered but never resulted in a durable outcome has not been used up.
    await tick(NOW_MS + SWEEP_INTERVAL_MS);
    assert.equal(pushes.length, 1, "the retry eventually reaches the owner");
    assert.equal((await attentionStore.getAttentionById(attentionId))?.notification_state, "sent");

    // And having now delivered, further ticks must not duplicate.
    for (let index = 2; index <= 20; index += 1) {
      await tick(NOW_MS + index * SWEEP_INTERVAL_MS);
    }
    assert.equal(pushes.length, 1, "recovering the retry must not cost the exactly-once property");
  })
);

test(
  "a delivery that fails at the sender is recorded and not retried forever",
  withRealStore(async ({ attentionStore, pushes, tick }) => {
    // Distinguishes the two failure shapes. Above, nothing was recorded because
    // the notifier never got as far as sending. Here the send itself is reached
    // and reports no delivery, which IS a durable outcome: the record carries
    // `failed`, and later ticks leave it alone rather than retrying in a loop.
    const attentionId = deviceSilenceAttentionId("dsi_1", SILENT_AT);

    await tick(NOW_MS);
    assert.equal(pushes.length, 1);
    await attentionStore.recordNotificationOutcomeById({
      attentionId,
      outcome: "failed",
      reason: "no_delivery",
    });

    await tick(NOW_MS + SWEEP_INTERVAL_MS);
    await tick(NOW_MS + 2 * SWEEP_INTERVAL_MS);

    assert.equal(pushes.length, 1, "a recorded failure is an outcome, not an unconsumed edge");
    assert.equal((await attentionStore.getAttentionById(attentionId))?.notification_state, "failed");
  })
);

test("a resolved notice is not reopened, and its late push does not undo the owner's decision", async () => {
  // The accepted residual, pinned rather than left implicit. A tick that has
  // already selected a row will send for it even if the owner resolves in
  // between — a late notification about a real outage. What must never happen is
  // the record being reopened, because that would put work back in front of the
  // owner that they had already dealt with.
  initDb(":memory:");
  try {
    await seedSilentDevice();
    const attentionStore = getDefaultConnectorAttentionStore();
    const result = await createDeviceSilenceStage().run({ nowIso: new Date(NOW_MS).toISOString() });
    const attentionId = result.opened[0]?.attentionId ?? "";
    const pushes: SentPush[] = [];

    // The owner resolves after the stage selected this row.
    await attentionStore.transitionAttention({ attentionId, to: "resolved" });

    await notifyDeviceSilenceOpened(result, {
      config: CONFIG,
      connectorDisplayName: () => "Claude Code",
      now: () => new Date(NOW_MS),
      ownerSubjectId: "owner_local",
      sendEscalationPush: ((args: SentPush) => {
        pushes.push(args);
        return Promise.resolve({ attempted: 1, sent: 1, unavailable: false });
      }) as never,
    });

    const stored = await attentionStore.getAttentionById(attentionId);
    assert.equal(stored?.lifecycle, "resolved", "the owner's decision stands");
    assert.equal(stored?.notification_state, "sent", "and the delivery is recorded honestly");

    // And the next tick does not select it again, so the lateness is bounded to
    // the one tick that had already chosen the row.
    const next = await createDeviceSilenceStage().run({ nowIso: new Date(NOW_MS + 60_000).toISOString() });
    assert.equal(next.detected, 0, "a resolved notice is not selected again");
  } finally {
    closeDb();
  }
});

test("an outcome that was never recorded is retried on a later tick", async () => {
  // The other half of the residual: nothing is lost. A send that records no
  // outcome — because the process died, or the attempt threw before reaching the
  // transport — leaves the record selectable, so the next tick tries again.
  initDb(":memory:");
  try {
    await seedSilentDevice();
    const attentionStore = getDefaultConnectorAttentionStore();
    const attentionId = deviceSilenceAttentionId("dsi_1", SILENT_AT);

    // A tick selects and opens the record, and nothing records an outcome.
    const first = await createDeviceSilenceStage().run({ nowIso: new Date(NOW_MS).toISOString() });
    assert.equal(first.opened.length, 1);
    assert.equal((await attentionStore.getAttentionById(attentionId))?.notification_updated_at, null);

    // A fresh stage over the same database still sees it, and delivers.
    const pushes: SentPush[] = [];
    const second = await createDeviceSilenceStage().run({ nowIso: new Date(NOW_MS + 60_000).toISOString() });
    assert.equal(second.opened.length, 1, "an unrecorded outcome leaves the notice selectable");
    await notifyDeviceSilenceOpened(second, {
      config: CONFIG,
      connectorDisplayName: () => "Claude Code",
      now: () => new Date(NOW_MS + 60_000),
      ownerSubjectId: "owner_local",
      sendEscalationPush: ((args: SentPush) => {
        pushes.push(args);
        return Promise.resolve({ attempted: 1, sent: 1, unavailable: false });
      }) as never,
    });
    assert.equal(pushes.length, 1, "the notice nobody recorded is delivered");
    assert.equal((await attentionStore.getAttentionById(attentionId))?.notification_state, "sent");
  } finally {
    closeDb();
  }
});
