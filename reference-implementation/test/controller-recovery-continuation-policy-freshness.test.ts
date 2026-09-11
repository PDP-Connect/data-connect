// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * R2 — THE RECOVERY-CONTINUATION PERMISSION TOCTOU.
 *
 * A recovery continuation is started BY THE CONTROLLER after a run makes
 * durable detail-gap progress, up to twelve envelopes with a minimum interval
 * between them. The automation-policy gate that decides whether it may start
 * used to read `input.manifest` — an object snapshotted at the PARENT run's
 * start and then threaded through every subsequent envelope.
 *
 * The registered manifest is MUTABLE for the whole life of the server:
 * `registerConnector` -> `persistManifestAndAdvanceGenerations` overwrites
 * `connectors.manifest` and bumps `connector_instances.manifest_generation`.
 * So the permission decision was made against a snapshot that could be
 * arbitrarily stale — a chain can span minutes — and an owner who paused a
 * connector mid-chain kept getting unattended background runs against a
 * decision they had already revoked. That is the defect: TIME OF CHECK
 * (parent run start) vs TIME OF USE (continuation admission).
 *
 * The repair separates two questions that the single pinned object was
 * answering at once:
 *
 *   - "how do I run?"     -> execution identity, still pinned, so a chain does
 *                            not silently switch implementations mid-envelope.
 *   - "may I run at all?" -> CURRENT registered policy, resolved fresh at
 *                            continuation admission, and the continuation is
 *                            then bound to that same admitted manifest so the
 *                            decision and the run cannot disagree.
 *
 * Fail CLOSED: if the registry read yields nothing or throws, the continuation
 * is withheld. Nothing is lost — gaps stay durable and an owner-initiated run
 * drains them.
 *
 * THESE TESTS DRIVE THE REAL REGISTRATION PATH. `registerConnector` is what an
 * owner's pause or manifest update actually calls, and it is what advances the
 * generation. A test that seeded `connectors` with raw SQL would prove nothing
 * about the path the defect lives on — and would silently accept manifests
 * (`streams: []`) that real registration rejects.
 *
 * The barrier is deterministic, not a sleep: the manifest change is committed
 * from INSIDE the first `runConnectorImpl` invocation, which is strictly after
 * the parent run snapshotted its manifest and strictly before the
 * post-run continuation check. That is exactly the TOCTOU window.
 *
 * Run:
 *   PDPP_TEST_PROFILE=memory-default node --test --import tsx \
 *     reference-implementation/test/controller-recovery-continuation-policy-freshness.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ControllerOptions } from "../runtime/controller.ts";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions } from "../runtime/index.ts";
import { registerConnector } from "../server/auth.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const CONNECTOR = "amazon";
const CONNECTION = "cin_policy_freshness";

const AUTOMATIC_REFRESH_POLICY = {
  background_safe: true,
  interaction_posture: "none",
  rationale: "Read-only order history over a durable session; safe to refresh unattended.",
  recommended_mode: "automatic",
};

const PAUSED_REFRESH_POLICY = {
  rationale: "Owner paused refresh for this connector.",
  recommended_mode: "paused",
};

const MANUAL_ONLY_REFRESH_POLICY = {
  background_safe: false,
  interaction_posture: "otp_likely",
  rationale: "Requires OTP and short-lived browser sessions; never refresh in the background.",
  recommended_mode: "manual",
};

/**
 * A manifest `validateConnectorManifest` accepts: a non-empty `streams` array
 * of valid stream shapes, and a `rationale` on any declared `refresh_policy`.
 *
 * `marker` makes the stored JSON content-different between registrations.
 * `persistManifestAndAdvanceGenerations` compares canonical JSON and NO-OPS on
 * an identical re-registration, so without it a same-policy commit would not
 * advance the generation and the barrier would silently test nothing.
 */
function manifestWithRefreshPolicy(refreshPolicy: Record<string, unknown> | null, marker = "v1") {
  return {
    connector_id: CONNECTOR,
    display_name: "Recovery policy freshness",
    manifest_uri: `https://registry.pdpp.dev/connectors/${CONNECTOR}`,
    protocol_version: "0.1.0",
    runtime_requirements: {},
    streams: [
      {
        name: "orders",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: `1.0.0-${marker}`,
    ...(refreshPolicy ? { capabilities: { refresh_policy: refreshPolicy } } : {}),
  };
}

function freshDb(t: TestContext) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-recovery-policy-freshness-")), "pdpp.sqlite"));
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
 * Reports eligible recovery work until `stop()` is called.
 *
 * Deliberately NOT scripted by read count. `registerConnector` runs inside the
 * barrier and the number of gap reads a run performs is an implementation
 * detail of the controller, so a positional script silently falls off its end
 * and starves the continuation — which looks exactly like the gate withholding
 * and would make these tests pass for the wrong reason. Gating on "has the
 * continuation already run?" ties the fixture to the behavior under test
 * instead of to a call count.
 */
function detailGapStoreUntilStopped(isStopped: () => boolean) {
  const next = () => (isStopped() ? [] : [pendingRecoveryGap()]);
  return {
    listPendingGapsForConnector: () => next(),
    listPendingGapsForConnectorInstance: () => next(),
  };
}

function fakeAdmitRunConnection() {
  return ({
    connectorId,
    connectorInstanceId,
    ownerSubjectId: requestedOwnerSubjectId,
  }: {
    connectorId: string;
    connectorInstanceId: string | null;
    ownerSubjectId: string | null;
  }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
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

/**
 * Seeds the connection row plus the terminal spine event and summary evidence
 * that `resolveEffectiveRecoveryOnly`'s forward-evidence-debt bound reads.
 * Without it debt reads true, the root run diverts to forward mode, and the
 * continuation path under test is never reached.
 *
 * The `connectors` row itself is NOT seeded here — each test registers it
 * through `registerConnector`, the real path.
 */
async function seedConnectionEvidence(registeredConnectorId: string) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_1', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(CONNECTION, registeredConnectorId, CONNECTION, now, now);
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, manifest_generation, data_json, version
       ) VALUES ('evt_seed_policy_freshness', (SELECT COALESCE(MAX(event_seq),0)+1 FROM spine_events), 'run.completed', ?, ?, 'test', 'trace_seed_policy_freshness', 'runtime', 'test-connector', 'run', 'run_seed_policy_freshness', 'succeeded', 'run_seed_policy_freshness', ?, 0, ?, '1')`
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

function readManifestGeneration(): number {
  const row = getDb()
    .prepare("SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = ?")
    .get<{ manifest_generation?: number }>(CONNECTION);
  return Number(row?.manifest_generation ?? 0);
}

/**
 * Runs one root run that makes durable detail-gap progress, committing
 * `committedMidRun` through the REAL registration path from inside the first
 * connector invocation — after the parent run pinned its manifest, before the
 * continuation check.
 *
 * Returns every connector invocation plus the generation observed either side
 * of the barrier, so a test can assert the barrier actually landed rather than
 * assuming it did.
 */
async function runWithMidRunManifestChange(input: {
  readonly registered: Record<string, unknown>;
  readonly committedMidRun: Record<string, unknown> | null;
  readonly onBarrier?: () => void;
}): Promise<{
  readonly calls: RuntimeRunConnectorOptions[];
  readonly generationBefore: number;
  readonly generationAfter: number;
}> {
  const registeredConnectorId = await registerConnector(input.registered, { backfillRetrievalIndexes: false });
  await seedConnectionEvidence(registeredConnectorId);
  const generationBefore = readManifestGeneration();

  const calls: RuntimeRunConnectorOptions[] = [];
  const runConnectorImpl: ControllerOptions["runConnectorImpl"] = async (opts) => {
    calls.push(opts);
    if (calls.length === 1) {
      // THE BARRIER. Strictly after the parent run snapshotted its manifest
      // and strictly before `maybeContinueRecoveryAfterProgress` runs.
      if (input.committedMidRun) {
        await registerConnector(input.committedMidRun, { backfillRetrievalIndexes: false });
      }
      input.onBarrier?.();
      return {
        detail_gaps: [{ gap_id: "gap_recovered", status: "recovered", stream: "order_items" }],
        records_emitted: 1,
        status: "succeeded",
      };
    }
    return { detail_gaps: [], records_emitted: 0, status: "succeeded" };
  };

  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.ts",
    // Stop offering work once the continuation has started, so a chain that
    // is permitted drains exactly one extra envelope rather than twelve.
    detailGapStore: detailGapStoreUntilStopped(() => calls.length >= 2),
    logger: { error: () => undefined, warn: () => undefined },
    ownerSubjectId: "owner_1",
    runConnectorImpl,
  });

  await controller.runNow(registeredConnectorId, {
    connectorInstanceId: CONNECTION,
    // The parent run pins THIS object, exactly as a real caller does. Every
    // continuation used to inherit it.
    manifest: input.registered,
    ownerToken: "owner-token",
    runId: "run_policy_freshness_root",
  });
  await drainUntilIdle(controller);

  return { calls, generationAfter: readManifestGeneration(), generationBefore };
}

test("a pause committed mid-run withholds the continuation", async (t) => {
  freshDb(t);

  const result = await runWithMidRunManifestChange({
    committedMidRun: manifestWithRefreshPolicy(PAUSED_REFRESH_POLICY, "v2"),
    registered: manifestWithRefreshPolicy(AUTOMATIC_REFRESH_POLICY, "v1"),
  });

  // Premise: the barrier really landed. Without an advanced generation the
  // test would pass for the wrong reason.
  assert.equal(
    result.generationAfter,
    result.generationBefore + 1,
    "premise: the mid-run registration must advance the manifest generation",
  );

  // The pinned manifest still says 'automatic'. Only a CURRENT read sees the
  // pause, so this is the assertion the TOCTOU failed.
  assert.equal(result.calls.length, 1, "a committed pause must take effect on the very next continuation");
});

test("a manual-only change committed mid-run withholds the continuation", async (t) => {
  freshDb(t);

  const result = await runWithMidRunManifestChange({
    committedMidRun: manifestWithRefreshPolicy(MANUAL_ONLY_REFRESH_POLICY, "v2"),
    registered: manifestWithRefreshPolicy(AUTOMATIC_REFRESH_POLICY, "v1"),
  });

  assert.equal(
    result.generationAfter,
    result.generationBefore + 1,
    "premise: the mid-run registration must advance the manifest generation",
  );
  assert.equal(result.calls.length, 1, "a connector turned manual-only mid-run must not self-chain");
});

test("an unchanged permission still self-chains", async (t) => {
  freshDb(t);

  // The control. If withholding were unconditional, every assertion above
  // would pass for a reason that has nothing to do with policy freshness.
  const result = await runWithMidRunManifestChange({
    committedMidRun: null,
    registered: manifestWithRefreshPolicy(AUTOMATIC_REFRESH_POLICY, "v1"),
  });

  assert.equal(
    result.generationAfter,
    result.generationBefore,
    "premise: no manifest change means no generation advance",
  );
  assert.equal(result.calls.length, 2, "an unchanged automatic policy must keep draining recovery work");
});

test("a re-registration that does not change the policy still self-chains", async (t) => {
  freshDb(t);

  // Freshness must react to the POLICY, not merely to the fact that something
  // was written. A connector updated mid-run for an unrelated reason must not
  // lose its continuation.
  const result = await runWithMidRunManifestChange({
    committedMidRun: manifestWithRefreshPolicy(AUTOMATIC_REFRESH_POLICY, "v2"),
    registered: manifestWithRefreshPolicy(AUTOMATIC_REFRESH_POLICY, "v1"),
  });

  assert.equal(
    result.generationAfter,
    result.generationBefore + 1,
    "premise: a content-different re-registration must advance the generation",
  );
  assert.equal(result.calls.length, 2, "an unrelated manifest update must not withhold the continuation");
});

test("a manifest that becomes unreadable mid-run withholds the continuation", async (t) => {
  freshDb(t);

  // Fail-closed. `getConnectorManifest` THROWS on a stored manifest it cannot
  // parse, rather than returning null. With no current permission to rely on,
  // the safe reading of "I cannot tell whether I am allowed" is to stop.
  const result = await runWithMidRunManifestChange({
    committedMidRun: null,
    onBarrier: () => {
      getDb().prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?").run('{"broken":true}', CONNECTOR);
    },
    registered: manifestWithRefreshPolicy(AUTOMATIC_REFRESH_POLICY, "v1"),
  });

  assert.equal(result.calls.length, 1, "an unreadable registered manifest must withhold, not self-chain");
});

// NOT TESTED HERE: deregistering the connector mid-run (the `!registeredManifest`
// branch of the gate). `connector_instances.connector_id` is a foreign key onto
// `connectors`, so deleting the row while a live connection references it fails
// the constraint and the RUN itself errors — the continuation is then never
// reached and an assertion on `calls.length` would pass without exercising the
// branch at all. The adjacent unreadable-manifest test covers the same
// fail-closed behavior through the path that is actually reachable.

test("the continuation executes the manifest its admission was decided against", async (t) => {
  freshDb(t);

  // Execution identity is bound to the SAME object the gate judged. Admitting
  // on current policy and then running an obsolete manifest would be the same
  // defect wearing different clothes: the connector path and stream shapes
  // would not be the ones just permitted.
  const result = await runWithMidRunManifestChange({
    committedMidRun: manifestWithRefreshPolicy(AUTOMATIC_REFRESH_POLICY, "v2"),
    registered: manifestWithRefreshPolicy(AUTOMATIC_REFRESH_POLICY, "v1"),
  });

  assert.equal(result.calls.length, 2, "premise: an automatic policy must still self-chain");
  const continuation = result.calls[1];
  assert.ok(continuation);
  const ranManifest = continuation.manifest as { version?: string } | undefined;
  assert.equal(
    ranManifest?.version,
    "1.0.0-v2",
    "the continuation must run the CURRENT manifest, not the one the parent run pinned",
  );
});
