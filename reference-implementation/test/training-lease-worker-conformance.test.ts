// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AI-training lease prototype: worker conformance (lease note L7, L8, L9, L11).
 *
 * The oracle in every test is real (simulated) time: no completed training
 * step that includes an owner's examples may end after that owner's lease
 * `exp`. The worker sees only its monotonic clock and a trusted-time reading,
 * which the tests stall, roll back or remove.
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
  type Ed25519KeyPair,
  generateEd25519KeyPair,
  signCompactJws,
} from "../lib/training-lease/jws.ts";
import { SimClock } from "../lib/training-lease/sim-clock.ts";
import {
  GrantAuthorityGuard,
  type InputLineage,
  JobRecorder,
  type Jwks,
  lineageKey,
  validateLeaseStatic,
} from "../lib/training-lease/worker.ts";

const ISS = "https://as.example";
const CLIENT = "client-trainer";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

function jwksOf(...keys: Ed25519KeyPair[]): Jwks {
  return { keys: keys.map((k) => ({ ...k.publicJwk, kid: k.kid })) };
}

function lease(
  key: Ed25519KeyPair,
  claims: Partial<Record<string, unknown>> & { grant_id: string },
  iatMs: number,
  lifetimeMs = 60 * MIN,
): string {
  return signCompactJws(
    { typ: LEASE_JWS_TYP, kid: key.kid },
    {
      iss: ISS,
      aud: CLIENT,
      jti: `jti-${Math.random().toString(36).slice(2)}`,
      permission: AI_TRAINING_PERMISSION,
      iat: Math.floor(iatMs / 1000),
      exp: Math.floor((iatMs + lifetimeMs) / 1000),
      ...claims,
    },
    key.privateKey,
  );
}

function lineage(grantId: string): InputLineage {
  return { iss: ISS, clientId: CLIENT, grantId };
}

function examples(grantId: string, n: number): TrainingExample[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${grantId}-${i}`,
    lineage: lineage(grantId),
    value: 1,
  }));
}

function setup(opts: {
  grants: string[];
  stepMs: number;
  drainMs: number;
  policy?: "drop" | "pause";
}) {
  const clock = new SimClock(T0);
  const recorder = new JobRecorder(clock);
  const key = generateEd25519KeyPair("k1");
  const jwks = jwksOf(key);
  const guards = new Map<string, GrantAuthorityGuard>();
  for (const g of opts.grants) {
    guards.set(
      lineageKey(lineage(g)),
      new GrantAuthorityGuard(lineage(g), clock, recorder, {
        drainMs: opts.drainMs,
        safetyMarginMs: 1000,
        maxClockUncertaintyMs: 5000,
        suspendDetectionSlackMs: 2000,
      }),
    );
  }
  const trainer = new ToyTrainer({
    guards,
    recorder,
    stepMs: opts.stepMs,
    microSteps: 10,
    batchSize: 4,
    mixedOwnerPolicy: opts.policy ?? "drop",
    advance: (ms) => clock.advance(ms),
    trueNow: () => clock.trueMs,
  });
  const guard = (g: string) =>
    guards.get(lineageKey(lineage(g))) as GrantAuthorityGuard;
  return { clock, recorder, key, jwks, guards, trainer, guard };
}

/** Oracle: every completed step ends before each contributing owner's lease exp. */
function assertNoStepPastExpiry(
  steps: ToyTrainer["completed"],
  expByGrant: Map<string, number>,
): void {
  for (const step of steps) {
    for (const g of step.grantIds) {
      const exp = expByGrant.get(g);
      if (exp === undefined) {
        continue;
      }
      assert.ok(
        step.endedTrueMs <= exp,
        `step with ${g} ended ${step.endedTrueMs - exp}ms after lease exp`,
      );
    }
  }
}

describe("L7 lease validation against input lineage", () => {
  const key = generateEd25519KeyPair("k1");
  const jwks = jwksOf(key);
  const now = T0;

  it("accepts a lease that matches iss, aud, permission and grant_id", () => {
    const v = validateLeaseStatic(
      lease(key, { grant_id: "g1" }, now),
      jwks,
      lineage("g1"),
    );
    assert.equal(v.ok, true);
  });

  it("rejects a lease for the wrong grant", () => {
    const v = validateLeaseStatic(
      lease(key, { grant_id: "g2" }, now),
      jwks,
      lineage("g1"),
    );
    assert.deepEqual(v, { ok: false, reason: "wrong_grant" });
  });

  it("rejects a lease for the wrong audience", () => {
    const v = validateLeaseStatic(
      lease(key, { grant_id: "g1", aud: "other-client" }, now),
      jwks,
      lineage("g1"),
    );
    assert.deepEqual(v, { ok: false, reason: "wrong_audience" });
  });

  it("rejects a lease from another issuer, a wrong permission, a long lifetime, a foreign key", () => {
    const l = lineage("g1");
    assert.deepEqual(
      validateLeaseStatic(
        lease(key, { grant_id: "g1", iss: "https://evil.example" }, now),
        jwks,
        l,
      ),
      { ok: false, reason: "wrong_issuer" },
    );
    assert.deepEqual(
      validateLeaseStatic(
        lease(
          key,
          { grant_id: "g1", permission: "https://pdpp.dev/processing/other" },
          now,
        ),
        jwks,
        l,
      ),
      { ok: false, reason: "wrong_permission" },
    );
    assert.deepEqual(
      validateLeaseStatic(
        lease(key, { grant_id: "g1" }, now, 61 * MIN),
        jwks,
        l,
      ),
      { ok: false, reason: "lifetime_exceeds_profile" },
    );
    const foreign = generateEd25519KeyPair("k1");
    assert.deepEqual(
      validateLeaseStatic(lease(foreign, { grant_id: "g1" }, now), jwks, l),
      {
        ok: false,
        reason: "bad_signature",
      },
    );
  });
});

describe("L7 conformance: expiry during a step", () => {
  it("does not start a step that cannot finish before the deadline", () => {
    const s = setup({ grants: ["g1"], stepMs: 10 * MIN, drainMs: 12 * MIN });
    const tok = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    const expMs = Math.floor((s.clock.trueMs + 60 * MIN) / 1000) * 1000;
    assert.equal(s.guard("g1").accept(tok, s.jwks).ok, true);
    s.trainer.enqueue(examples("g1", 40));
    for (let i = 0; i < 20; i += 1) {
      const out = s.trainer.step();
      if (out.kind !== "completed") {
        break;
      }
    }
    assertNoStepPastExpiry(s.trainer.completed, new Map([["g1", expMs]]));
    // 10-minute steps from T0 within a 60-minute lease: at most 5 complete.
    assert.ok(s.trainer.completed.length <= 5);
    assert.ok(s.trainer.completed.length >= 4);
    assert.ok(s.recorder.ofType("admission_stopped").length >= 1);
  });

  it("aborts an in-flight step when real time crosses the deadline mid-step", () => {
    // The guard underestimates nothing here; the step itself runs slower than
    // its declared worst case (a stall), so only the per-slice check saves it.
    const s = setup({ grants: ["g1"], stepMs: 10 * MIN, drainMs: 12 * MIN });
    const tok = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    const expMs = Math.floor((s.clock.trueMs + 60 * MIN) / 1000) * 1000;
    s.guard("g1").accept(tok, s.jwks);
    s.trainer.enqueue(examples("g1", 8));
    s.clock.advance(45 * MIN); // 15 minutes left: one 10-minute step may start
    const slow = new ToyTrainer({
      guards: s.guards,
      recorder: s.recorder,
      stepMs: 10 * MIN,
      microSteps: 10,
      batchSize: 4,
      mixedOwnerPolicy: "drop",
      advance: (ms) => s.clock.advance(ms * 3), // runs 3x slower than declared
      trueNow: () => s.clock.trueMs,
    });
    slow.queue.push(...s.trainer.queue);
    const out = slow.step();
    assert.equal(out.kind, "aborted");
    assertNoStepPastExpiry(slow.completed, new Map([["g1", expMs]]));
    assert.equal(slow.weight, 0, "an aborted step applies no update");
    assert.equal(s.recorder.ofType("step_aborted").length, 1);
  });
});

describe("L7 conformance: resume after expiry", () => {
  it("requires revalidation after resume and refuses an expired lease", () => {
    const s = setup({ grants: ["g1"], stepMs: MIN, drainMs: 2 * MIN });
    const tok = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    s.guard("g1").accept(tok, s.jwks);
    assert.equal(s.guard("g1").canAdmit().ok, true);
    s.clock.advance(70 * MIN);
    s.guard("g1").onResume();
    assert.equal(s.guard("g1").canAdmit().ok, false);
    assert.deepEqual(s.guard("g1").accept(tok, s.jwks), {
      ok: false,
      reason: "expired",
    });
    assert.equal(s.guard("g1").canAdmit().ok, false);
  });

  it("detects an unobserved system suspend (monotonic clock stalled) without a resume signal", () => {
    // CLOCK_MONOTONIC stops during suspend on Linux. A deadline held only in
    // monotonic time would be extended by the suspend duration.
    const s = setup({ grants: ["g1"], stepMs: MIN, drainMs: 2 * MIN });
    const tok = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    s.guard("g1").accept(tok, s.jwks);
    s.clock.suspend(90 * MIN);
    assert.equal(s.guard("g1").canAdmit().ok, false);
    assert.ok(
      s.recorder
        .ofType("revalidation_required")
        .some((e) => e.reason === "monotonic_stall_detected"),
    );
    assert.deepEqual(s.guard("g1").accept(tok, s.jwks), {
      ok: false,
      reason: "expired",
    });
  });

  it("documents the limit: with no trusted time after an unsignalled suspend, the monotonic deadline is extended", () => {
    const s = setup({ grants: ["g1"], stepMs: MIN, drainMs: 2 * MIN });
    const tok = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    const expMs = Math.floor((s.clock.trueMs + 60 * MIN) / 1000) * 1000;
    s.guard("g1").accept(tok, s.jwks);
    s.clock.suspend(90 * MIN);
    s.clock.trustedAvailable = false;
    // The guard cannot see the suspend; it still admits, past real expiry.
    assert.equal(s.guard("g1").canAdmit().ok, true);
    assert.ok(s.clock.trueMs > expMs);
  });

  it("a restored checkpoint carries no authority", () => {
    const s = setup({ grants: ["g1"], stepMs: MIN, drainMs: 2 * MIN });
    const tok = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    s.guard("g1").accept(tok, s.jwks);
    const cp = s.guard("g1").checkpoint();
    s.clock.advance(10 * MIN);
    s.clock.restartProcess();
    const fresh = new GrantAuthorityGuard(lineage("g1"), s.clock, s.recorder);
    fresh.restoreCheckpoint(cp);
    assert.equal(fresh.canAdmit().ok, false);
    assert.equal(fresh.accept(tok, s.jwks).ok, true);
    assert.equal(fresh.canAdmit().ok, true);
  });
});

describe("L7 conformance: clock rollback", () => {
  it("a wall-clock rollback while running does not extend the monotonic deadline", () => {
    const s = setup({ grants: ["g1"], stepMs: 5 * MIN, drainMs: 6 * MIN });
    const tok = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    const expMs = Math.floor((s.clock.trueMs + 60 * MIN) / 1000) * 1000;
    s.guard("g1").accept(tok, s.jwks);
    s.trainer.enqueue(examples("g1", 60));
    s.clock.advance(20 * MIN);
    s.clock.trustedOffsetMs = -2 * 60 * MIN; // clock set back two hours
    for (let i = 0; i < 40; i += 1) {
      if (s.trainer.step().kind !== "completed") {
        break;
      }
    }
    assertNoStepPastExpiry(s.trainer.completed, new Map([["g1", expMs]]));
    // Re-accepting the same lease under the rolled-back clock is refused.
    assert.deepEqual(s.guard("g1").accept(tok, s.jwks), {
      ok: false,
      reason: "clock_rollback",
    });
  });

  it("a rollback across a restart, larger than the time since the last accept, is caught by the persisted high-water mark", () => {
    const s = setup({ grants: ["g1"], stepMs: MIN, drainMs: 2 * MIN });
    const tok = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    s.guard("g1").accept(tok, s.jwks);
    s.clock.advance(65 * MIN);
    const cp = s.guard("g1").checkpoint();
    s.clock.restartProcess();
    s.clock.trustedOffsetMs = -2 * 60 * MIN;
    const fresh = new GrantAuthorityGuard(lineage("g1"), s.clock, s.recorder);
    fresh.restoreCheckpoint(cp);
    assert.deepEqual(fresh.accept(tok, s.jwks), {
      ok: false,
      reason: "clock_rollback",
    });
  });

  it("documents the limit: a smaller rollback across a restart is not caught when the high-water mark is only refreshed on accept", () => {
    const s = setup({ grants: ["g1"], stepMs: MIN, drainMs: 2 * MIN });
    const tok = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    s.guard("g1").accept(tok, s.jwks);
    s.clock.advance(65 * MIN); // lease is now expired in real time
    const cp = s.guard("g1").checkpoint();
    s.clock.restartProcess();
    s.clock.trustedOffsetMs = -30 * MIN;
    const fresh = new GrantAuthorityGuard(lineage("g1"), s.clock, s.recorder);
    fresh.restoreCheckpoint(cp);
    // The high-water mark is from before expiry (T0), so a 30-minute rollback
    // after a 65-minute run still reads as "later than T0". The persisted mark
    // must be refreshed as time passes, not only at accept().
    const v = fresh.accept(tok, s.jwks);
    assert.equal(
      v.ok,
      true,
      "LIMIT: high-water updated only on accept; a rollback smaller than the time since last accept is not caught",
    );
  });

  it("fails closed when trusted-time uncertainty exceeds the margin", () => {
    const s = setup({ grants: ["g1"], stepMs: MIN, drainMs: 2 * MIN });
    s.clock.uncertaintyMs = 10_000;
    const tok = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    assert.deepEqual(s.guard("g1").accept(tok, s.jwks), {
      ok: false,
      reason: "clock_uncertain",
    });
    s.clock.trustedAvailable = false;
    assert.deepEqual(s.guard("g1").accept(tok, s.jwks), {
      ok: false,
      reason: "no_trusted_time",
    });
  });
});

describe("L7/L8 conformance: mixed-owner batch with one owner withdrawn", () => {
  it("drops the withdrawn owner's examples and keeps training the others", () => {
    const s = setup({
      grants: ["g1", "g2"],
      stepMs: 5 * MIN,
      drainMs: 6 * MIN,
    });
    const tok1 = lease(s.key, { grant_id: "g1" }, s.clock.trueMs);
    const exp1 = Math.floor((s.clock.trueMs + 60 * MIN) / 1000) * 1000;
    s.guard("g1").accept(tok1, s.jwks);
    let tok2 = lease(s.key, { grant_id: "g2" }, s.clock.trueMs);
    s.guard("g2").accept(tok2, s.jwks);
    const exp2s: number[] = [];
    // Interleave both owners so every batch is mixed.
    const mixed: TrainingExample[] = [];
    const a = examples("g1", 60);
    const b = examples("g2", 60);
    for (let i = 0; i < 60; i += 1) {
      mixed.push(a[i] as TrainingExample, b[i] as TrainingExample);
    }
    s.trainer.enqueue(mixed);
    // g1 withdraws at T0: its lease is never renewed. g2 renews every 25 min.
    let lastRenew = s.clock.trueMs;
    for (let i = 0; i < 40; i += 1) {
      if (s.clock.trueMs - lastRenew >= 25 * MIN) {
        tok2 = lease(s.key, { grant_id: "g2" }, s.clock.trueMs);
        exp2s.push(Math.floor((s.clock.trueMs + 60 * MIN) / 1000) * 1000);
        s.guard("g2").accept(tok2, s.jwks);
        lastRenew = s.clock.trueMs;
      }
      const out = s.trainer.step();
      if (out.kind === "idle") {
        break;
      }
    }
    assertNoStepPastExpiry(s.trainer.completed, new Map([["g1", exp1]]));
    const lastG1 = Math.max(
      ...s.trainer.completed
        .filter((st) => st.grantIds.includes("g1"))
        .map((st) => st.endedTrueMs),
    );
    assert.ok(lastG1 <= exp1);
    const g2After = s.trainer.completed.filter(
      (st) => st.startedTrueMs > exp1 && st.grantIds.includes("g2"),
    );
    assert.ok(g2After.length > 0, "g2 kept training after g1's lease ran out");
    assert.ok(g2After.every((st) => !st.grantIds.includes("g1")));
    assert.ok(s.recorder.ofType("drained").some((e) => e.grant_id === "g1"));
  });

  it("pauses the whole job when the policy says one owner's data cannot be removed", () => {
    const s = setup({
      grants: ["g1", "g2"],
      stepMs: 5 * MIN,
      drainMs: 6 * MIN,
      policy: "pause",
    });
    s.guard("g1").accept(
      lease(s.key, { grant_id: "g1" }, s.clock.trueMs),
      s.jwks,
    );
    s.guard("g2").accept(
      lease(s.key, { grant_id: "g2" }, s.clock.trueMs, 60 * MIN),
      s.jwks,
    );
    s.trainer.enqueue([...examples("g1", 2), ...examples("g2", 2)]);
    s.clock.advance(57 * MIN);
    const out = s.trainer.step();
    assert.equal(out.kind, "paused");
    assert.equal(s.trainer.weight, 0);
    assert.equal(s.recorder.ofType("job_paused").length, 1);
  });
});

describe("L9 emergency key withdrawal", () => {
  it("a refreshed JWKS without the relied-on key ends authority at once", () => {
    const s = setup({ grants: ["g1"], stepMs: MIN, drainMs: 2 * MIN });
    s.guard("g1").accept(
      lease(s.key, { grant_id: "g1" }, s.clock.trueMs),
      s.jwks,
    );
    assert.equal(s.guard("g1").canAdmit().ok, true);
    s.guard("g1").onJwksRefreshed({ keys: [] });
    assert.equal(s.guard("g1").canAdmit().ok, false);
    assert.ok(
      s.recorder
        .ofType("authority_ended")
        .some((e) => e.reason === "signing_key_withdrawn"),
    );
  });
});

describe("L11 job records", () => {
  it("records the jtis relied on, the clock margin, admission stop and drain", () => {
    const s = setup({ grants: ["g1"], stepMs: 10 * MIN, drainMs: 12 * MIN });
    s.guard("g1").accept(
      lease(s.key, { grant_id: "g1", jti: "lease-1" }, s.clock.trueMs),
      s.jwks,
    );
    s.trainer.enqueue(examples("g1", 40));
    for (let i = 0; i < 20; i += 1) {
      if (s.trainer.step().kind !== "completed") {
        break;
      }
    }
    const relied = s.recorder.ofType("lease_relied");
    assert.deepEqual(
      relied.map((e) => e.jti),
      ["lease-1"],
    );
    assert.equal(relied[0]?.clock_margin_ms, 50 + 1000);
    assert.ok(s.recorder.ofType("admission_stopped").length > 0);
    assert.ok(s.recorder.ofType("drained").length > 0);
  });
});
