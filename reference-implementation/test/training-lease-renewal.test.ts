// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AI-training lease prototype: client renewal (lease note L2) and fail-closed
 * behavior when the AS is unreachable (L8), driven end to end through the
 * renewer, the worker guard and the toy trainer on a simulated clock.
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToyTrainer,
  type TrainingExample,
} from "../examples/training-lease-trainer/trainer.ts";
import {
  AI_TRAINING_PERMISSION,
  LEASE_JWS_TYP,
} from "../lib/training-lease/constants.ts";
import {
  generateEd25519KeyPair,
  signCompactJws,
} from "../lib/training-lease/jws.ts";
import {
  DEFAULT_RENEWAL_POLICY,
  type LeaseFetchResult,
  LeaseRenewer,
  latestRenewalStartMs,
  plannedRenewalAtMs,
} from "../lib/training-lease/renewer.ts";
import { SimClock } from "../lib/training-lease/sim-clock.ts";
import {
  GrantAuthorityGuard,
  type InputLineage,
  JobRecorder,
  lineageKey,
} from "../lib/training-lease/worker.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const ISS = "https://as.example";
const CLIENT = "client-trainer";

describe("L2 renewal schedule", () => {
  it("starts no later than half-life; jitter only moves it earlier", () => {
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const at = plannedRenewalAtMs(
        T0,
        T0 + HOUR,
        DEFAULT_RENEWAL_POLICY,
        () => r,
      );
      assert.ok(at <= latestRenewalStartMs(T0, T0 + HOUR));
      assert.ok(
        at >=
          latestRenewalStartMs(T0, T0 + HOUR) -
            DEFAULT_RENEWAL_POLICY.jitterMaxMs,
      );
    }
    assert.equal(
      plannedRenewalAtMs(T0, T0 + HOUR, DEFAULT_RENEWAL_POLICY, () => 0),
      T0 + 30 * MIN,
    );
    assert.equal(
      plannedRenewalAtMs(T0, T0 + 30 * MIN, DEFAULT_RENEWAL_POLICY, () => 0),
      T0 + 15 * MIN,
    );
  });
});

interface Scenario {
  /** AS refuses (unreachable) in [outageFrom, outageTo). */
  outageFromMs: number;
  outageToMs: number;
  /** After this time the AS answers "no lease" (withdrawn). */
  withdrawnAtMs?: number;
  leaseLifetimeMs?: number;
  durationMs: number;
}

/** Drive one owner's training job for the scenario; returns what happened. */
async function run(s: Scenario) {
  const clock = new SimClock(T0);
  const recorder = new JobRecorder(clock);
  const key = generateEd25519KeyPair("k1");
  const jwks = { keys: [{ ...key.publicJwk, kid: key.kid }] };
  const lineage: InputLineage = { clientId: CLIENT, grantId: "g1", iss: ISS };
  const guard = new GrantAuthorityGuard(lineage, clock, recorder, {
    drainMs: 3 * MIN,
  });
  const guards = new Map([[lineageKey(lineage), guard]]);
  const trainer = new ToyTrainer({
    advance: (ms) => clock.advance(ms),
    batchSize: 4,
    guards,
    microSteps: 4,
    mixedOwnerPolicy: "drop",
    recorder,
    stepMs: MIN,
    trueNow: () => clock.trueMs,
  });
  const issued: number[] = [];
  const fetchLease = async (): Promise<LeaseFetchResult> => {
    const now = clock.trueMs;
    if (s.withdrawnAtMs !== undefined && now >= s.withdrawnAtMs) {
      return { error: "no_lease", ok: false, terminal: true };
    }
    if (now >= s.outageFromMs && now < s.outageToMs) {
      return { error: "unreachable", ok: false, terminal: false };
    }
    const iat = Math.floor(now / 1000);
    const exp = iat + Math.floor((s.leaseLifetimeMs ?? HOUR) / 1000);
    issued.push(exp * 1000);
    return {
      lease: signCompactJws(
        { kid: key.kid, typ: LEASE_JWS_TYP },
        {
          aud: CLIENT,
          exp,
          grant_id: "g1",
          iat,
          iss: ISS,
          jti: `j${issued.length}`,
          permission: AI_TRAINING_PERMISSION,
        },
        key.privateKey,
      ),
      ok: true,
    };
  };
  const renewer = new LeaseRenewer({
    fetchLease,
    grantId: "g1",
    onLease: (l) => guard.accept(l.token, jwks),
    random: () => 0.5,
    recorder,
  });
  let n = 0;
  const examples = (k: number): TrainingExample[] =>
    Array.from({ length: k }, (_, i) => ({
      id: `e${n + i}`,
      lineage,
      value: 1,
    }));
  while (clock.trueMs < T0 + s.durationMs) {
    await renewer.step(clock.trueMs);
    if (trainer.queue.length < 8) {
      trainer.enqueue(examples(8));
      n += 8;
    }
    if (trainer.step().kind !== "completed") {
      clock.advance(MIN);
    }
  }
  return { issued, recorder, renewer, trainer };
}

/** Longest pause between consecutive completed steps. */
function maxPause(steps: ToyTrainer["completed"]): number {
  return Math.max(
    0,
    ...steps
      .slice(1)
      .map(
        (st, i) =>
          st.startedTrueMs - (steps[i]?.endedTrueMs ?? st.startedTrueMs),
      ),
  );
}

function lastCoveringExp(issued: number[], atMs: number): number {
  return Math.max(...issued.filter((e) => e - HOUR <= atMs));
}

describe("L8 fail closed when the AS is unreachable", () => {
  it("an outage shorter than the remaining half-life does not interrupt training", async () => {
    // First renewal is due at T0+30min. An outage from T0+29 to T0+50 makes
    // renewal retry for ~20 minutes, inside the 30 minutes left.
    const r = await run({
      durationMs: 2 * HOUR,
      outageFromMs: T0 + 29 * MIN,
      outageToMs: T0 + 50 * MIN,
    });
    assert.ok(
      r.recorder.ofType("renewal").some((e) => !e.ok),
      "renewal failures were recorded",
    );
    assert.equal(maxPause(r.trainer.completed), 0, "no pause in training");
  });

  it("an outage longer than the remaining lease stops training by lease expiry, then resumes when the AS returns", async () => {
    const outageFrom = T0 + 10 * MIN;
    const outageTo = T0 + 2 * HOUR;
    const r = await run({
      durationMs: 3 * HOUR,
      outageFromMs: outageFrom,
      outageToMs: outageTo,
    });
    const exp = lastCoveringExp(r.issued, outageFrom);
    const during = r.trainer.completed.filter(
      (st) => st.endedTrueMs > exp && st.startedTrueMs < outageTo,
    );
    assert.equal(
      during.length,
      0,
      "no step ends after the last lease's exp during the outage",
    );
    const lastBefore = Math.max(
      ...r.trainer.completed
        .filter((st) => st.endedTrueMs <= exp)
        .map((st) => st.endedTrueMs),
    );
    assert.ok(
      exp - lastBefore <= 3 * MIN + MIN,
      "admission closed one drain window before exp",
    );
    assert.ok(
      r.trainer.completed.some((st) => st.startedTrueMs >= outageTo),
      "training resumed after the AS returned",
    );
    const failures = r.recorder.ofType("renewal").filter((e) => !e.ok).length;
    assert.ok(
      failures > 5,
      `the client kept retrying with backoff (${failures} failures)`,
    );
  });

  it("withdrawal: the AS answers no lease, the client stops asking, training stops by the last exp", async () => {
    const withdrawnAt = T0 + 40 * MIN;
    const r = await run({
      durationMs: 3 * HOUR,
      outageFromMs: 0,
      outageToMs: 0,
      withdrawnAtMs: withdrawnAt,
    });
    const t = Math.max(...r.issued);
    assert.ok(r.trainer.completed.every((st) => st.endedTrueMs <= t));
    assert.equal(r.renewer.terminal, "no_lease");
    assert.ok(t - withdrawnAt <= HOUR, "stopped within one hour of withdrawal");
    process.stdout.write(
      `# withdrawal at +40min; T = +${(t - T0) / MIN}min; stop lag ${(t - withdrawnAt) / MIN}min\n`,
    );
  });

  it("measures outage tolerance: about 30 minutes for a 60-minute lease, 15 for a 30-minute lease", async () => {
    for (const lifetime of [HOUR, 30 * MIN]) {
      let tolerated = 0;
      for (let outage = 5 * MIN; outage <= 60 * MIN; outage += 5 * MIN) {
        const from = T0 + lifetime / 2 - MIN; // just before the first renewal
        const r = await run({
          durationMs: 3 * HOUR,
          leaseLifetimeMs: lifetime,
          outageFromMs: from,
          outageToMs: from + outage,
        });
        if (maxPause(r.trainer.completed) === 0) {
          tolerated = outage;
        }
      }
      process.stdout.write(
        `# lease ${lifetime / MIN}min: tolerated outage ${tolerated / MIN}min (drain 3min)\n`,
      );
      assert.ok(
        tolerated >= lifetime / 2 - 10 * MIN &&
          tolerated <= lifetime / 2 + 5 * MIN,
      );
    }
  });
});
