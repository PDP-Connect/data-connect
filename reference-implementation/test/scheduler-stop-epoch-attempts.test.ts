// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Automatic-dispatch validity across the attempt boundary.
//
// `scheduler-stop-epoch.test.ts` covers the gaps before the first attempt. These
// tests cover what the review of that fix found still open: the direct route's
// durable active-run admission, retries on both routes (stop, stop-then-start,
// and a disabled schedule without any stop), side effects of an abandoned
// credential lookup, the managed-to-direct fallback, and the escalation push.
//
// One rule drives all of them: an automatic dispatch is valid only while its
// captured epoch is not aborted AND the schedule is still enabled in the store,
// and that is re-checked immediately before every attempt starts.
//
// Every test awaits a deferred that the code under test must resolve, so each
// carries HANG_GUARD: a regression fails the test instead of hanging the file.
// Cleanup is registered with `t.after` (scheduler first, then the database): a
// timed-out test body never resumes, so a `finally` would not run.

import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";

import type {
  HumanRequiredStateEscalationHandler,
  RunManagedConnectorViaController,
  RunRecord,
} from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";
import { createEscalationDelivery } from "../server/scheduler-manager-factory.ts";
import {
  buildStore,
  deferred,
  directScheduler,
  drain,
  HANG_GUARD,
  OWNER,
  type ScheduleRow,
  writeConnector,
} from "./helpers/scheduler-stop-harness.ts";

// ── (a) direct route: durable active-run admission ─────────────────────────

for (const variant of ["stop", "disable"] as const) {
  test(`direct route: ${variant} while durable active-run admission is pending starts no connector`, HANG_GUARD, async (t) => {
    initDb(":memory:");
    const connector = writeConnector(t, "succeed");
    const upsertEntered = deferred<void>();
    const upsertGate = deferred<void>();
    const leaseCleared = deferred<void>();
    let row: ScheduleRow = { enabled: true };
    const { completed, scheduler } = directScheduler(
      connector.connectorPath,
      buildStore(() => row, {
        deleteActiveRun: () => leaseCleared.resolve(),
        upsertActiveRun: async () => {
          upsertEntered.resolve();
          await upsertGate.promise;
          return true;
        },
      })
    );
    t.after(() => scheduler.stop());
    t.after(() => closeDb());

    scheduler.start();
    await upsertEntered.promise;

    if (variant === "stop") {
      scheduler.stop();
    } else {
      row = { enabled: false };
    }
    upsertGate.resolve();
    // The lease is released on every exit path; with the bug this fires only
    // after the connector has run to completion.
    await leaseCleared.promise;
    await drain();

    assert.equal(connector.starts(), 0, "the connector must not start for an invalidated dispatch");
    assert.deepEqual(completed, [], "a dropped dispatch records no run, failure or skip");
  });
}

// ── (b) direct route: retries ──────────────────────────────────────────────

// Runs attempt 1 (a crashing connector, so retryable) until the retry back-off
// sleep is entered, with `setTimeout` mocked so the 1 s back-off is advanced by
// the test rather than waited for.
async function runToRetrySleep(t: TestContext, row: () => ScheduleRow) {
  initDb(":memory:");
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const connector = writeConnector(t, "crash");
  const firstAttemptCleared = deferred<void>();
  const secondAttemptCleared = deferred<void>();
  const settled = deferred<void>();
  let clears = 0;
  const harness = directScheduler(
    connector.connectorPath,
    buildStore(row, {
      deleteActiveRun: () => {
        clears += 1;
        (clears === 1 ? firstAttemptCleared : secondAttemptCleared).resolve();
      },
    })
  );
  t.after(() => harness.scheduler.stop());
  t.after(() => closeDb());
  const originalComplete = harness.completed.push.bind(harness.completed);
  harness.completed.push = (...records: RunRecord[]) => {
    settled.resolve();
    return originalComplete(...records);
  };
  harness.scheduler.start();
  await firstAttemptCleared.promise;
  await drain();
  assert.equal(connector.starts(), 1, "attempt 1 ran and the dispatch is now in its retry back-off");
  // Either the dispatch was dropped and recorded (`settled`) or, if it wrongly
  // retried, attempt 2 ran (`secondAttemptCleared`); the test then fails on the
  // start count instead of hanging in the next, still-mocked, back-off.
  return {
    ...harness,
    connector,
    outcome: Promise.race([settled.promise, secondAttemptCleared.promise]),
    secondAttemptCleared: secondAttemptCleared.promise,
  };
}

test("direct route: stop() then start() during the retry back-off does not resurrect the old attempt", HANG_GUARD, async (t) => {
  const { connector, outcome, scheduler } = await runToRetrySleep(t, () => ({ enabled: true }));

  scheduler.stop();
  scheduler.start();
  mock.timers.tick(1000);
  await outcome;

  assert.equal(connector.starts(), 1, "the old epoch must not start attempt 2 after a stop/start");
});

test("direct route: a schedule disabled during the retry back-off is not retried, even without a stop", HANG_GUARD, async (t) => {
  let row: ScheduleRow = { enabled: true };
  const { connector, outcome } = await runToRetrySleep(t, () => row);

  row = { enabled: false };
  mock.timers.tick(1000);
  await outcome;

  assert.equal(connector.starts(), 1, "a disabled schedule must not be retried");
});

test("direct route: a live, still-enabled schedule still retries", HANG_GUARD, async (t) => {
  const { connector, secondAttemptCleared } = await runToRetrySleep(t, () => ({ enabled: true }));

  mock.timers.tick(1000);
  await secondAttemptCleared;

  assert.equal(connector.starts(), 2, "an enabled schedule on a live scheduler keeps retrying");
});

// ── managed route: retries ─────────────────────────────────────────────────

// A managed run whose first attempt fails retryably, paused inside its retry
// back-off (`setTimeout` mocked).
async function runManagedToRetrySleep(t: TestContext, row: () => ScheduleRow) {
  initDb(":memory:");
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const calls: number[] = [];
  const firstCall = deferred<void>();
  const secondCall = deferred<void>();
  const settled = deferred<void>();
  const via: RunManagedConnectorViaController = async () => {
    calls.push(calls.length + 1);
    if (calls.length === 1) {
      firstCall.resolve();
    }
    if (calls.length === 2) {
      secondCall.resolve();
    }
    return { failure_reason: "boom", run_id: `run_${calls.length}`, status: "failed", trace_id: "trace" };
  };
  const { scheduler } = directScheduler("/nonexistent/connector.mjs", buildStore(row), {
    isManagedConnector: () => true,
    onRunComplete: () => settled.resolve(),
    runManagedConnectorViaController: via,
  });
  t.after(() => scheduler.stop());
  t.after(() => closeDb());
  scheduler.start();
  // The first attempt has run and the loop is in its back-off sleep once the
  // controller has been called and the event loop is quiet.
  await firstCall.promise;
  await drain();
  assert.deepEqual(calls, [1]);
  // Either the dispatch was dropped and recorded (`settled`) or it wrongly
  // retried (`secondCall`); the test then fails on `calls` instead of hanging.
  return {
    calls,
    outcome: Promise.race([settled.promise, secondCall.promise]),
    scheduler,
    secondCall: secondCall.promise,
  };
}

test("managed route: stop() during the retry back-off does not start another controller run", HANG_GUARD, async (t) => {
  const { calls, outcome, scheduler } = await runManagedToRetrySleep(t, () => ({ enabled: true }));

  scheduler.stop();
  mock.timers.tick(1000);
  await outcome;

  assert.deepEqual(calls, [1]);
});

test("managed route: a schedule disabled during the retry back-off is not retried, even without a stop", HANG_GUARD, async (t) => {
  let row: ScheduleRow = { enabled: true };
  const { calls, outcome } = await runManagedToRetrySleep(t, () => row);

  row = { enabled: false };
  mock.timers.tick(1000);
  await outcome;

  assert.deepEqual(calls, [1]);
});

test("managed route: a live, still-enabled schedule still retries", HANG_GUARD, async (t) => {
  const { calls, secondCall } = await runManagedToRetrySleep(t, () => ({ enabled: true }));

  mock.timers.tick(1000);
  await secondCall;

  assert.deepEqual(calls, [1, 2]);
});

// ── (c) abandoned credential lookup: no side effects ───────────────────────

test("an abandoned credential lookup that rejects after stop() stamps no last-run time and marks no needs-human", HANG_GUARD, async (t) => {
  const lookupEntered = deferred<void>();
  const lookupGate = deferred<void>();
  const stamps: number[] = [];
  const needsHuman: string[] = [];
  const { completed, scheduler } = directScheduler(
    "/nonexistent/connector.mjs",
    buildStore(() => ({ enabled: true }), { upsertLastRunTime: () => stamps.push(1) }),
    {
      markNeedsHuman: (id) => needsHuman.push(id),
      resolveStaticSecretRunEnv: async () => {
        lookupEntered.resolve();
        await lookupGate.promise;
        throw Object.assign(new Error("credential revoked"), { code: "credential_revoked" });
      },
    }
  );
  t.after(() => scheduler.stop());

  scheduler.start();
  await lookupEntered.promise;
  scheduler.stop();
  lookupGate.resolve();
  await drain();

  assert.deepEqual(stamps, [], "an abandoned dispatch must not advance the cadence");
  assert.deepEqual(needsHuman, [], "an abandoned dispatch must not mark the connection needs-human");
  assert.deepEqual(completed, []);
});

// ── (d) managed-to-direct fallback after a stop ────────────────────────────

test("a managed callback that resolves null after stop() drops the dispatch instead of recording a failed run", HANG_GUARD, async (t) => {
  const viaEntered = deferred<void>();
  const viaGate = deferred<null>();
  const stamps: number[] = [];
  const { completed, scheduler } = directScheduler(
    "/nonexistent/connector.mjs",
    buildStore(() => ({ enabled: true }), { upsertLastRunTime: () => stamps.push(1) }),
    {
      isManagedConnector: () => true,
      runManagedConnectorViaController: async () => {
        viaEntered.resolve();
        return await viaGate.promise;
      },
    }
  );
  t.after(() => scheduler.stop());

  scheduler.start();
  await viaEntered.promise;
  scheduler.stop();
  viaGate.resolve(null);
  await drain();

  assert.deepEqual(completed, [], "no attempt ran, so no run record may be finalized");
  assert.deepEqual(stamps, [], "no attempt ran, so the cadence must not advance");
});

// ── store read failure at final admission ──────────────────────────────────

test("a failed schedule read at final admission drops the dispatch", HANG_GUARD, async (t) => {
  const reads = deferred<void>();
  const calls: string[] = [];
  const { completed, scheduler } = directScheduler(
    "/nonexistent/connector.mjs",
    buildStore(undefined, {
      getSchedule: () => {
        reads.resolve();
        throw new Error("store unavailable");
      },
    }),
    {
      isManagedConnector: () => true,
      runManagedConnectorViaController: (id) => {
        calls.push(id);
        return { run_id: "run_x", status: "succeeded", trace_id: "trace" };
      },
    }
  );
  t.after(() => scheduler.stop());

  scheduler.start();
  await reads.promise;
  await drain();

  assert.deepEqual(calls, [], "an unreadable schedule is fail-closed");
  assert.deepEqual(completed, []);
});

// ── (e) escalation push ────────────────────────────────────────────────────

for (const variant of ["stop", "disable"] as const) {
  test(`an escalation raised by an automatic dispatch is not deliverable after ${variant === "stop" ? "stop()" : "a disable"}`, HANG_GUARD, async (t) => {
    const raised = deferred<Parameters<HumanRequiredStateEscalationHandler>[0]>();
    let row: ScheduleRow = { enabled: true };
    const { scheduler } = directScheduler(
      "/nonexistent/connector.mjs",
      buildStore(() => row),
      {
        isNeedsHuman: () => true,
        onHumanRequiredStateEscalation: (info) => raised.resolve(info),
      }
    );
    t.after(() => scheduler.stop());

    scheduler.start();
    const info = await raised.promise;
    assert.ok(info.shouldDeliver, "an automatic escalation carries a delivery guard");
    assert.equal(await info.shouldDeliver(), true, "deliverable while the dispatch is valid");

    if (variant === "stop") {
      scheduler.stop();
    } else {
      row = { enabled: false };
    }
    assert.equal(await info.shouldDeliver(), false, "not deliverable once the dispatch is invalid");
  });
}

test("an escalation raised after stop() is never delivered", HANG_GUARD, async (t) => {
  const preflightEntered = deferred<void>();
  const preflightGate = deferred<void>();
  const raised: unknown[] = [];
  const { scheduler } = directScheduler(
    "/nonexistent/connector.mjs",
    buildStore(() => ({ enabled: true })),
    {
      isNeedsHuman: () => true,
      onHumanRequiredStateEscalation: (info) => {
        raised.push(info);
      },
      readinessChecker: async () => {
        preflightEntered.resolve();
        await preflightGate.promise;
        return { ready: true };
      },
    }
  );
  t.after(() => scheduler.stop());

  scheduler.start();
  await preflightEntered.promise;
  scheduler.stop();
  preflightGate.resolve();
  await drain();

  assert.deepEqual(raised, [], "a stopped scheduler must not raise an escalation");
});

test("an escalation raised by a stopped epoch after a restart is bound to the old epoch and not delivered", HANG_GUARD, async (t) => {
  const preflightEntered = deferred<void>();
  const preflightGate = deferred<void>();
  const raised: Parameters<HumanRequiredStateEscalationHandler>[0][] = [];
  const { scheduler } = directScheduler(
    "/nonexistent/connector.mjs",
    buildStore(() => ({ enabled: true })),
    {
      isNeedsHuman: () => true,
      onHumanRequiredStateEscalation: (info) => {
        raised.push(info);
      },
      readinessChecker: async () => {
        preflightEntered.resolve();
        await preflightGate.promise;
        return { ready: true };
      },
    }
  );
  t.after(() => scheduler.stop());

  scheduler.start();
  await preflightEntered.promise;
  scheduler.stop();
  scheduler.start();
  await drain();
  preflightGate.resolve();
  await drain();

  for (const info of raised) {
    assert.equal(await info.shouldDeliver?.(), false, "the old epoch's escalation must not adopt the new epoch");
  }
  assert.deepEqual(raised, [], "a stopped epoch must not raise an escalation, even after a restart");
});

// ── (f) post-lease guard liveness ──────────────────────────────────────────

test("an abort during the post-lease schedule read releases the lease and a later start can dispatch", HANG_GUARD, async (t) => {
  initDb(":memory:");
  const connector = writeConnector(t, "succeed");
  const readEntered = deferred<void>();
  const firstLeaseCleared = deferred<void>();
  const secondLeaseCleared = deferred<void>();
  let clears = 0;
  let leased = false;
  let hang = true;
  const { scheduler } = directScheduler(
    connector.connectorPath,
    buildStore(undefined, {
      deleteActiveRun: () => {
        clears += 1;
        (clears === 1 ? firstLeaseCleared : secondLeaseCleared).resolve();
      },
      getSchedule: async () => {
        if (leased && hang) {
          readEntered.resolve();
          await new Promise<never>(() => undefined);
        }
        return { enabled: true };
      },
      upsertActiveRun: () => {
        leased = true;
        return true;
      },
    })
  );
  t.after(() => scheduler.stop());
  t.after(() => closeDb());

  scheduler.start();
  await readEntered.promise;
  scheduler.stop();
  await firstLeaseCleared.promise;
  await drain();
  assert.equal(connector.starts(), 0, "no connector starts for the aborted dispatch");

  hang = false;
  scheduler.start();
  // The restarted dispatch runs the connector and then releases its own lease.
  await secondLeaseCleared.promise;
  assert.equal(connector.starts(), 1, "the key is dispatchable again after the aborted dispatch released it");
});

// ── (g) credential failure: decide before any side effect ──────────────────

test("a credential failure never applies its cadence and needs-human effects without its record", HANG_GUARD, async (t) => {
  const stamps: number[] = [];
  const needsHuman: string[] = [];
  let failed = false;
  let readsAfterFailure = 0;
  const { completed, scheduler } = directScheduler(
    "/nonexistent/connector.mjs",
    buildStore(undefined, {
      getSchedule: () => {
        if (failed) {
          readsAfterFailure += 1;
          if (readsAfterFailure > 1) {
            throw new Error("store unavailable");
          }
        }
        return { enabled: true };
      },
      upsertLastRunTime: () => stamps.push(1),
    }),
    {
      markNeedsHuman: (id) => needsHuman.push(id),
      resolveStaticSecretRunEnv: () => {
        failed = true;
        return Promise.reject(Object.assign(new Error("credential revoked"), { code: "credential_revoked" }));
      },
    }
  );
  t.after(() => scheduler.stop());

  scheduler.start();
  await drain();

  assert.ok(readsAfterFailure >= 1, "the failure path consulted the schedule");
  // The failure's effects and its record are applied together or not at all.
  assert.equal(stamps.length, completed.length, "a cadence stamp needs the matching failure record");
  assert.equal(needsHuman.length, completed.length, "a needs-human flag needs the matching failure record");
});

// ── (h) outer emissions follow the durable schedule ────────────────────────

const WEDGE_CEILING_MS = 30;

for (const enabledAtDeadline of [true, false]) {
  test(`a wedged preflight ${enabledAtDeadline ? "records" : "does not record"} the wedge when the schedule is ${enabledAtDeadline ? "enabled" : "disabled"} at the deadline`, HANG_GUARD, async (t) => {
    // The liveness ceiling is the only timer the test waits on, so it is
    // advanced by hand instead of slept through.
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const readinessEntered = deferred<void>();
    const readAfterDeadline = deferred<void>();
    const row = { enabled: true };
    let deadlineElapsed = false;
    const { completed, scheduler } = directScheduler(
      "/nonexistent/connector.mjs",
      buildStore(undefined, {
        getSchedule: () => {
          if (deadlineElapsed) {
            readAfterDeadline.resolve();
          }
          return row;
        },
      }),
      {
        dispatchLivenessCeilingMs: WEDGE_CEILING_MS,
        readinessChecker: async () => {
          readinessEntered.resolve();
          await new Promise<never>(() => undefined);
          return { ready: true };
        },
      }
    );
    t.after(() => scheduler.stop());

    scheduler.start();
    await readinessEntered.promise;
    row.enabled = enabledAtDeadline;
    deadlineElapsed = true;
    mock.timers.tick(WEDGE_CEILING_MS);
    // The wedge path revalidates the dispatch with one schedule read; its record
    // (or its absence) settles in the turns that follow.
    await readAfterDeadline.promise;
    await drain();

    assert.equal(
      completed.filter((record) => record.failureReason === "scheduler_dispatch_wedged").length,
      enabledAtDeadline ? 1 : 0
    );
  });
}

// ── (i) escalation push through the real factory consumer ──────────────────

for (const variant of ["stop", "disable", "none"] as const) {
  test(`factory escalation consumer: ${variant} while the verdict projection is pending ${variant === "none" ? "delivers the push" : "sends no push"}`, HANG_GUARD, async (t) => {
    const projectionEntered = deferred<void>();
    const projectionGate = deferred<void>();
    const handled = deferred<Promise<void>>();
    let listed = 0;
    let row: ScheduleRow = { enabled: true };
    const deliver = createEscalationDelivery({
      controller: {} as Parameters<typeof createEscalationDelivery>[0]["controller"],
      logger: { warn: () => undefined },
      ownerSubjectId: OWNER,
      project: async () => {
        projectionEntered.resolve();
        await projectionGate.promise;
        return {
          connectionUrl: "/sources/x",
          connectorDisplayName: "X",
          renderedVerdict: {
            channel: "attention",
            required_actions: [{ audience: "owner", satisfied_when: { kind: "owner_action" } }],
          },
        };
      },
      webPushConfig: {
        enabled: true,
        privateKey: "k",
        publicKey: "p",
        subject: "mailto:test@example.invalid",
        unavailableReason: null,
      },
      webPushSubscriptionStore: {
        listActiveRaw: () => {
          listed += 1;
          return [];
        },
      } as unknown as Parameters<typeof createEscalationDelivery>[0]["webPushSubscriptionStore"],
    });
    const { scheduler } = directScheduler(
      "/nonexistent/connector.mjs",
      buildStore(() => row),
      {
        isNeedsHuman: () => true,
        onHumanRequiredStateEscalation: (info) => {
          handled.resolve(Promise.resolve(deliver(info)));
        },
      }
    );
    t.after(() => scheduler.stop());

    scheduler.start();
    await projectionEntered.promise;
    if (variant === "stop") {
      scheduler.stop();
    } else if (variant === "disable") {
      row = { enabled: false };
    }
    projectionGate.resolve();
    const settled = await handled.promise;
    await settled;

    assert.equal(listed, variant === "none" ? 1 : 0);
  });
}
