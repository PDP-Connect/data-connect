// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ControllerOptions } from "../runtime/controller.ts";
import {
  __resetControllerInteractionStateForTests,
  createController,
  isNeedsHumanAttention,
} from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions } from "../runtime/index.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

// The recovery continuation must honor the connector manifest's automation
// policy: no unattended manual-only relaunch.
//
// A recovery continuation (`maybeContinueRecoveryAfterProgress`, controller.ts)
// is started by the CONTROLLER after a run makes durable detail-gap progress.
// It is not an owner gesture — it is minted with `triggerKind: "manual"` only so
// it inherits manual-run admission. Before this gate it self-chained for every
// connector, up to MAX_RECOVERY_CONTINUATION_ENVELOPES envelopes, regardless of
// what the manifest declared about background refresh.
//
// For a connector whose manifest declares `recommended_mode: "manual"` with
// `background_safe: false` and `interaction_posture: "otp_likely"` — the shape
// of the real `chase` manifest in packages/polyfill-connectors — each envelope
// costs the owner an unprompted one-time passcode on their phone for a session
// they never started.
//
// The gate reuses `getScheduleIneligibilityReason`, the same predicate the
// schedule API and the scheduler's runnable-set filter use, so there is exactly
// one definition of "this manifest forbids automatic runs".
//
// Scope note: withholding the continuation is the whole behavior under test.
// These cases assert that no second connector invocation happens and that
// owner-visible attention state is left alone — the run succeeded and no
// interaction failed, so there is nothing to report by default.
//
// Harness mirrors controller-run-now-state-namespace.test.ts: real DB, fake
// admission, a stubbed `runConnectorImpl` that captures the opts each connector
// child would receive, and a read-count-scripted detail-gap store.

const CONNECTOR = "amazon";
const CONNECTION = "cin_policy_recovery";

/** Manifest capabilities shaped like the real `chase` polyfill manifest: a bank that must never refresh in the background. */
const MANUAL_ONLY_REFRESH_POLICY = {
  background_safe: false,
  interaction_posture: "otp_likely",
  rationale: "Requires OTP and short-lived browser sessions; never refresh in the background.",
  recommended_mode: "manual",
};

/** The permissive counterpart: a connector the owner's manifest says is safe to refresh unattended. */
const AUTOMATIC_REFRESH_POLICY = {
  background_safe: true,
  interaction_posture: "none",
  recommended_mode: "automatic",
};

function manifestWithRefreshPolicy(refreshPolicy: Record<string, unknown> | null) {
  return {
    connector_id: CONNECTOR,
    name: "Amazon",
    runtime_requirements: { bindings: { browser: { required: true } } },
    streams: [],
    version: "1.0.0",
    ...(refreshPolicy ? { capabilities: { refresh_policy: refreshPolicy } } : {}),
  };
}

function freshDb(t: TestContext) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-recovery-automation-policy-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

interface PendingDetailGapRowFixture {
  readonly attempt_count?: number | null;
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  readonly last_error?: { readonly class?: unknown } | null;
  readonly next_attempt_after?: string | null;
  readonly reason?: string | null;
  readonly status?: string | null;
  readonly stream?: string | null;
  readonly updated_at?: string | null;
}

interface DetailGapReadStoreFixture {
  listPendingGapsForConnector: (connectorId: string) => readonly PendingDetailGapRowFixture[];
  listPendingGapsForConnectorInstance?: (
    connectorId: string,
    connectorInstanceId: string
  ) => readonly PendingDetailGapRowFixture[];
}

function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

function makeController(
  calls: RuntimeRunConnectorOptions[],
  overrides: {
    detailGapStore?: DetailGapReadStoreFixture;
    runConnectorImpl?: ControllerOptions["runConnectorImpl"];
  } = {}
) {
  return createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.ts",
    ...(overrides.detailGapStore ? { detailGapStore: overrides.detailGapStore } : {}),
    logger: { error: () => undefined, warn: () => undefined },
    ownerSubjectId: "owner_1",
    runConnectorImpl:
      overrides.runConnectorImpl ||
      ((opts) => {
        calls.push(opts);
        return Promise.resolve({ records_emitted: 0, status: "succeeded" });
      }),
  });
}

async function drainUntilIdle(controller: ReturnType<typeof createController>, limit = 5) {
  for await (const _ of Array.from({ length: limit })) {
    const summary = await controller.drainActiveRuns(1000);
    if (summary.drained === 0 && summary.timedOut === 0) {
      return;
    }
  }
  throw new Error("controller did not become idle");
}

/** A pending gap that is non-pressure recovery work and admissible right now, so `hasEligibleNonPressureRecoveryWork` is true. */
function pendingRecoveryGap(): PendingDetailGapRowFixture {
  return {
    attempt_count: 1,
    connector_id: CONNECTOR,
    connector_instance_id: CONNECTION,
    last_error: { class: "run_cap_deferred" },
    next_attempt_after: null,
    reason: "retry_exhausted",
    status: "pending",
    stream: "order_items",
    updated_at: "2026-07-07T21:00:00.000Z",
  };
}

/**
 * Read-count-scripted gap store. `runNow` reads pending gaps twice per call
 * (pre-run recovery-first work selection, post-run continuation check); the
 * last entry is reused once the script runs out.
 */
function detailGapStoreForContinuation(
  rowsByCall: readonly (readonly PendingDetailGapRowFixture[])[]
): DetailGapReadStoreFixture {
  let instanceReadCount = 0;
  return {
    listPendingGapsForConnector: () => [],
    listPendingGapsForConnectorInstance: () => {
      const rows = rowsByCall[Math.min(instanceReadCount, rowsByCall.length - 1)] || [];
      instanceReadCount += 1;
      return rows;
    },
  };
}

/**
 * The forward-evidence-debt bound in `resolveEffectiveRecoveryOnly` reads a real
 * `connector_summary_evidence` row folded from a real `spine_events` row. Without
 * it, debt reads as true and the root run diverts to forward mode, so the
 * continuation path under test is never reached at all.
 */
async function seedCurrentRecoveryConnection(manifest: Record<string, unknown>) {
  const now = new Date().toISOString();
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR, JSON.stringify(manifest), now);
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_1', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(CONNECTION, CONNECTOR, CONNECTION, now, now);
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, manifest_generation, data_json, version
       ) VALUES ('evt_seed_policy_recovery', (SELECT COALESCE(MAX(event_seq),0)+1 FROM spine_events), 'run.completed', ?, ?, 'test', 'trace_seed_policy_recovery', 'runtime', 'test-connector', 'run', 'run_seed_policy_recovery', 'succeeded', 'run_seed_policy_recovery', ?, 0, ?, '1')`
    )
    .run(
      now,
      now,
      CONNECTION,
      JSON.stringify({
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams: [{ checkpoint: "committed", collected: 1, considered: 1, stream: "order_items" }],
        },
        connection_id: CONNECTION,
        connector_instance_id: CONNECTION,
      })
    );
  await reconcileDirtyConnectorSummaryEvidence([CONNECTION]);
}

/**
 * Drives one root run that makes durable detail-gap progress — the exact
 * precondition `maybeContinueRecoveryAfterProgress` requires before it would
 * self-chain — and returns every connector invocation the controller made.
 */
async function runRootWithDurableProgress(manifest: Record<string, unknown>) {
  await seedCurrentRecoveryConnection(manifest);

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    // Root pre-check and root post-run continuation check both see an eligible
    // pending gap; any later read sees none, so a continuation that does start
    // stops at depth 1 rather than chaining further.
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()], [pendingRecoveryGap()], []]),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        return Promise.resolve({
          detail_gaps: [{ gap_id: "gap_recovered", status: "recovered", stream: "order_items" }],
          records_emitted: 1,
          status: "succeeded",
        });
      }
      return Promise.resolve({ detail_gaps: [], records_emitted: 0, status: "succeeded" });
    },
  });

  await controller.runNow(CONNECTOR, {
    connectorInstanceId: CONNECTION,
    manifest,
    ownerToken: "owner-token",
    runId: "run_policy_root",
  });
  await drainUntilIdle(controller);
  return calls;
}

test("a manual-only connector does not self-chain a recovery continuation", async (t) => {
  freshDb(t);

  const calls = await runRootWithDurableProgress(manifestWithRefreshPolicy(MANUAL_ONLY_REFRESH_POLICY));

  // Every precondition for a continuation held: the run succeeded, it resolved
  // a detail gap durably, the depth budget was untouched, another eligible gap
  // was pending, and no continuation had run recently. The ONLY thing stopping
  // a second envelope is the manifest automation policy.
  assert.equal(calls.length, 1, "manual-only connector must not launch an unattended recovery continuation");

  // Withholding the continuation does not, on its own, change owner-visible
  // attention state: the run succeeded and no interaction failed. The pending
  // gaps stay durable and an owner-initiated run picks them up. Whether a
  // withheld continuation should ALSO raise a needs-owner-action signal is a
  // separate, deliberately separable decision.
  assert.equal(isNeedsHumanAttention(CONNECTOR, { connectorInstanceId: CONNECTION }), false);
});

test("an automatic-mode connector still self-chains a recovery continuation", async (t) => {
  freshDb(t);

  const calls = await runRootWithDurableProgress(manifestWithRefreshPolicy(AUTOMATIC_REFRESH_POLICY));

  assert.equal(calls.length, 2, "background-safe connector must keep draining recovery work unattended");
  assert.equal(calls[1]?.connectorInstanceId, CONNECTION);
  assert.equal(calls[1]?.recoveryOnly, true);
  assert.equal(calls[1]?.triggerKind, "manual");

  // The gate did not fire, so nothing was flagged for the owner.
  assert.equal(isNeedsHumanAttention(CONNECTOR, { connectorInstanceId: CONNECTION }), false);
});

test("a connector with no declared refresh policy still self-chains", async (t) => {
  freshDb(t);

  // `automaticIneligibilityReason(null)` is null: the gate only withholds on an
  // explicit manifest declaration, so connectors that predate `refresh_policy`
  // keep their existing behavior rather than silently losing recovery drain.
  const calls = await runRootWithDurableProgress(manifestWithRefreshPolicy(null));

  assert.equal(calls.length, 2, "absent refresh_policy must not be read as manual-only");
  assert.equal(isNeedsHumanAttention(CONNECTOR, { connectorInstanceId: CONNECTION }), false);
});

test("a paused connector does not self-chain a recovery continuation", async (t) => {
  freshDb(t);

  const calls = await runRootWithDurableProgress(manifestWithRefreshPolicy({ recommended_mode: "paused" }));

  assert.equal(calls.length, 1, "paused connector must not launch an unattended recovery continuation");
  assert.equal(isNeedsHumanAttention(CONNECTOR, { connectorInstanceId: CONNECTION }), false);
});

test("recommended_mode manual with an explicit background_safe opt-in still self-chains", async (t) => {
  freshDb(t);

  // `policyBlocksScheduledRuns` treats `recommended_mode: "manual"` as blocking
  // only "until background_safe=true is declared". A manifest that declares it
  // has made the unattended-refresh call explicitly, so the gate defers to it.
  const calls = await runRootWithDurableProgress(
    manifestWithRefreshPolicy({ background_safe: true, recommended_mode: "manual" })
  );

  assert.equal(calls.length, 2, "an explicit background_safe:true opt-in must be honored");
  assert.equal(isNeedsHumanAttention(CONNECTOR, { connectorInstanceId: CONNECTION }), false);
});
