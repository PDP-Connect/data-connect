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

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";

import { createScheduler } from "../runtime/scheduler.ts";
import type {
  HumanRequiredStateEscalationHandler,
  RunManagedConnectorViaController,
  RunRecord,
} from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  BACKGROUND_SAFE_MANIFEST,
  buildStore,
  CONNECTOR_ID,
  deferred,
  drain,
  INSTANCE_ID,
  OWNER,
  type ScheduleRow,
} from "./helpers/scheduler-stop-harness.ts";

// A real child connector. It appends a line to `startsPath` on START, so a
// start that must not happen is observable as a line, then either completes or
// crashes.
function writeConnector(t: TestContext, behaviour: "succeed" | "crash") {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-stop-epoch-attempts-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const connectorPath = join(dir, "connector.mjs");
  const startsPath = join(dir, "starts.log");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(${JSON.stringify(startsPath)}, 'start\\n', 'utf8');
  ${
    behaviour === "succeed"
      ? "process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n'); rl.close();"
      : "process.exit(1);"
  }
});
`,
    "utf8"
  );
  chmodSync(connectorPath, 0o755);
  const starts = (): number =>
    existsSync(startsPath) ? readFileSync(startsPath, "utf8").split("\n").filter(Boolean).length : 0;
  return { connectorPath, starts };
}

function admit(input: { connectorId: string; connectorInstanceId: string | null; ownerSubjectId: string | null }) {
  return Promise.resolve({
    connectorId: input.connectorId,
    connectorInstanceId: input.connectorInstanceId ?? input.connectorId,
    ownerSubjectId: input.ownerSubjectId ?? OWNER,
  });
}

type SchedulerOptions = Parameters<typeof createScheduler>[0];

function directScheduler(
  connectorPath: string,
  store: ReturnType<typeof buildStore>,
  extra: Partial<SchedulerOptions> = {}
) {
  const completed: RunRecord[] = [];
  const scheduler = createScheduler({
    admitRunConnection: admit,
    connectors: [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: INSTANCE_ID,
        connectorPath,
        intervalMs: 60_000,
        manifest: BACKGROUND_SAFE_MANIFEST,
        maxRetries: 2,
        ownerSubjectId: OWNER,
        ownerToken: "owner-token",
      },
    ],
    onInteraction: async () => ({ accepted: true, status: "cancelled" }),
    onRunComplete: (record) => completed.push(record),
    readinessChecker: async () => ({ ready: true }),
    rsUrl: "http://localhost.invalid",
    schedulerStore: store,
    ...extra,
  });
  return { completed, scheduler };
}

// ── (a) direct route: durable active-run admission ─────────────────────────

for (const variant of ["stop", "disable"] as const) {
  test(`direct route: ${variant} while durable active-run admission is pending starts no connector`, async (t) => {
    initDb(":memory:");
    t.after(() => closeDb());
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
    try {
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
    } finally {
      scheduler.stop();
    }
  });
}

// ── (b) direct route: retries ──────────────────────────────────────────────

// Runs attempt 1 (a crashing connector, so retryable) until the retry back-off
// sleep is entered, with `setTimeout` mocked so the 1 s back-off is advanced by
// the test rather than waited for.
async function runToRetrySleep(t: TestContext, row: () => ScheduleRow) {
  initDb(":memory:");
  t.after(() => closeDb());
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

test("direct route: stop() then start() during the retry back-off does not resurrect the old attempt", async (t) => {
  const { connector, outcome, scheduler } = await runToRetrySleep(t, () => ({ enabled: true }));
  try {
    scheduler.stop();
    scheduler.start();
    mock.timers.tick(1000);
    await outcome;

    assert.equal(connector.starts(), 1, "the old epoch must not start attempt 2 after a stop/start");
  } finally {
    scheduler.stop();
  }
});

test("direct route: a schedule disabled during the retry back-off is not retried, even without a stop", async (t) => {
  let row: ScheduleRow = { enabled: true };
  const { connector, outcome, scheduler } = await runToRetrySleep(t, () => row);
  try {
    row = { enabled: false };
    mock.timers.tick(1000);
    await outcome;

    assert.equal(connector.starts(), 1, "a disabled schedule must not be retried");
  } finally {
    scheduler.stop();
  }
});

test("direct route: a live, still-enabled schedule still retries", async (t) => {
  const { connector, scheduler, secondAttemptCleared } = await runToRetrySleep(t, () => ({ enabled: true }));
  try {
    mock.timers.tick(1000);
    await secondAttemptCleared;

    assert.equal(connector.starts(), 2, "an enabled schedule on a live scheduler keeps retrying");
  } finally {
    scheduler.stop();
  }
});

// ── managed route: retries ─────────────────────────────────────────────────

// A managed run whose first attempt fails retryably, paused inside its retry
// back-off (`setTimeout` mocked).
async function runManagedToRetrySleep(t: TestContext, row: () => ScheduleRow) {
  initDb(":memory:");
  t.after(() => closeDb());
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

test("managed route: stop() during the retry back-off does not start another controller run", async (t) => {
  const { calls, outcome, scheduler } = await runManagedToRetrySleep(t, () => ({ enabled: true }));
  try {
    scheduler.stop();
    mock.timers.tick(1000);
    await outcome;
    assert.deepEqual(calls, [1]);
  } finally {
    scheduler.stop();
  }
});

test("managed route: a schedule disabled during the retry back-off is not retried, even without a stop", async (t) => {
  let row: ScheduleRow = { enabled: true };
  const { calls, outcome, scheduler } = await runManagedToRetrySleep(t, () => row);
  try {
    row = { enabled: false };
    mock.timers.tick(1000);
    await outcome;
    assert.deepEqual(calls, [1]);
  } finally {
    scheduler.stop();
  }
});

test("managed route: a live, still-enabled schedule still retries", async (t) => {
  const { calls, scheduler, secondCall } = await runManagedToRetrySleep(t, () => ({ enabled: true }));
  try {
    mock.timers.tick(1000);
    await secondCall;
    assert.deepEqual(calls, [1, 2]);
  } finally {
    scheduler.stop();
  }
});

// ── (c) abandoned credential lookup: no side effects ───────────────────────

test("an abandoned credential lookup that rejects after stop() stamps no last-run time and marks no needs-human", async () => {
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
  try {
    scheduler.start();
    await lookupEntered.promise;
    scheduler.stop();
    lookupGate.resolve();
    await drain();

    assert.deepEqual(stamps, [], "an abandoned dispatch must not advance the cadence");
    assert.deepEqual(needsHuman, [], "an abandoned dispatch must not mark the connection needs-human");
    assert.deepEqual(completed, []);
  } finally {
    scheduler.stop();
  }
});

// ── (d) managed-to-direct fallback after a stop ────────────────────────────

test("a managed callback that resolves null after stop() drops the dispatch instead of recording a failed run", async () => {
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
  try {
    scheduler.start();
    await viaEntered.promise;
    scheduler.stop();
    viaGate.resolve(null);
    await drain();

    assert.deepEqual(completed, [], "no attempt ran, so no run record may be finalized");
    assert.deepEqual(stamps, [], "no attempt ran, so the cadence must not advance");
  } finally {
    scheduler.stop();
  }
});

// ── store read failure at final admission ──────────────────────────────────

test("a failed schedule read at final admission drops the dispatch", async () => {
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
  try {
    scheduler.start();
    await reads.promise;
    await drain();

    assert.deepEqual(calls, [], "an unreadable schedule is fail-closed");
    assert.deepEqual(completed, []);
  } finally {
    scheduler.stop();
  }
});

// ── (e) escalation push ────────────────────────────────────────────────────

test("an escalation raised by an automatic dispatch is not deliverable after stop() or a disable", async () => {
  for (const variant of ["stop", "disable"] as const) {
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
    try {
      scheduler.start();
      const info = await raised.promise;
      assert.ok(info.shouldDeliver, "an automatic escalation carries a delivery guard");
      assert.equal(await info.shouldDeliver(), true, `${variant}: deliverable while the dispatch is valid`);

      if (variant === "stop") {
        scheduler.stop();
      } else {
        row = { enabled: false };
      }
      assert.equal(await info.shouldDeliver(), false, `${variant}: not deliverable once the dispatch is invalid`);
    } finally {
      scheduler.stop();
    }
  }
});

test("an escalation raised after stop() is never delivered", async () => {
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
  try {
    scheduler.start();
    await preflightEntered.promise;
    scheduler.stop();
    preflightGate.resolve();
    await drain();

    assert.deepEqual(raised, [], "a stopped scheduler must not raise an escalation");
  } finally {
    scheduler.stop();
  }
});
