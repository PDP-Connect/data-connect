// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Held-data lifecycle prototype: timing traces against the AS authority and the client library,
 * under Core v0.1.0. AS silence starts no deadline: a client that cannot reach the AS keeps its data
 * and may use it as the grant permits. The limits that bind are the reconciliation interval (24 h),
 * the retry interval (1 h), the stop-use bound (48 h from the effective time) and the deletion bound
 * (30 d from first authenticated receipt). Each test prints what it measured.
 *
 * Notation: `w` the instruction's effective time, `q` the client's first authenticated receipt.
 * Core cases: C1 and C1a (attempts), C2 (stop use), C4 (deletion bound).
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeldDataClient } from "../lib/held-data/client.ts";
import { DAY, HOUR, MIN, Sim, T0 } from "./helpers/held-data-sim.ts";

function h(ms: number | null): string {
  return ms === null ? "never" : `${(ms / HOUR).toFixed(2)} h`;
}

function report(line: string): void {
  console.log(`[held-data-timing] ${line}`);
}

async function started(policy: ConstructorParameters<typeof Sim>[0] = {}) {
  const sim = new Sim(policy);
  sim.sync();
  await sim.client.reconcile();
  assert.equal(sim.client.canUse("g1").ok, true, "a positive assessment makes the copy usable");
  return sim;
}

describe("held-data timing traces (Core v0.1.0)", () => {
  it("C2/C4 online: erasure just after a check; use stops within 48 h of the effective time, deletion within 31 d", async () => {
    const sim = await started({ policy: { disposeAt: "deadline" } });
    sim.t = T0 + MIN;
    const w = sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" }).acceptedAt;
    const { lastUsable, lastSubUsable } = await sim.runUntil(w + 3 * DAY);
    const e = sim.client.grantState("g1")?.erasures.values().next().value;
    const q = e?.receivedAt ?? null;
    const gone = await sim.runUntilGone(w + 60 * DAY);
    assert.ok(lastUsable !== null && q !== null && gone !== null && e);
    report(
      `online: use after erasure ${h(lastUsable - w)}; subprocessor ${h((lastSubUsable ?? w) - w)}; receipt at w+${h(q - w)}; copy gone at w+${h(gone - w)} (= ${((gone - w) / DAY).toFixed(2)} d)`
    );
    assert.ok(lastUsable - w <= 48 * HOUR, "with the AS reachable, use stops within the stop-use bound of the effective time");
    assert.ok(gone - w <= 31 * DAY, "deletion within q + 30 d, q <= w + 24 h");
    assert.equal(e.stopUseBy, e.effectiveAt + 48 * HOUR, "the recorded stop-use bound is the effective time plus 48 h");
    assert.equal(e.learnedLate, false);
    assert.equal(e.stoppedUseAt, q, "use stopped at the instant of receipt");
    // The AS shows a deletion date only from the client's receipt.
    const view = sim.as.ownerView("g1", 30 * DAY);
    assert.equal(view?.erasures[0]?.receipt_at, q);
    assert.equal(view?.erasures[0]?.delete_by, q + 30 * DAY);
    assert.equal(view?.erasures[0]?.completion?.outcome, "deleted");
  });

  it("AS unreachable from just after the erasure: nothing stops use or deletes the copy; the client keeps trying hourly", async () => {
    const sim = await started();
    sim.t = T0 + 1000;
    const w = sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" }).acceptedAt;
    sim.outages = [[w, w + 400 * DAY]];
    const calls = sim.statusCalls;
    const { lastUsable, lastSubUsable } = await sim.runUntil(w + 365 * DAY, 6 * HOUR);
    report(
      `outage from w to 365 d: usable until w+${h((lastUsable ?? w) - w)}; subprocessor w+${h((lastSubUsable ?? w) - w)}; ${sim.statusCalls - calls} failed attempts`
    );
    assert.equal(lastUsable, w + 365 * DAY, "the client has not learned of the instruction, so silence stops no use");
    assert.deepEqual(sim.app.holds("g1"), { records: 2, indexEntries: 4, summary: true }, "and deletes nothing");
    // One tick per 6 h here, and each tick is a due attempt: at least one attempt per tick.
    assert.ok(sim.statusCalls - calls >= 365 * 4 - 4, "attempts continue for the whole outage");
    // Nothing was fabricated: the AS still shows the operation undelivered and no deletion date.
    assert.equal(sim.as.ownerView("g1", 30 * DAY)?.erasures[0]?.delivered_at, null);
    assert.equal(sim.as.ownerView("g1", 30 * DAY)?.erasures[0]?.delete_by, null);
  });

  it("C2 variant: the AS stays unreachable past w + 48 h; on the first answer the client stops at once and records that it learned late", async () => {
    const sim = await started({ policy: { disposeAt: "deadline" } });
    sim.t += MIN;
    const w = sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" }).acceptedAt;
    sim.outages = [[w, w + 5 * DAY]];
    const { lastUsable } = await sim.runUntil(w + 10 * DAY, 15 * MIN);
    const e = sim.client.grantState("g1")?.erasures.values().next().value;
    assert.ok(e && lastUsable !== null);
    report(`late receipt: receipt at w+${h(e.receivedAt - w)}; last use at w+${h(lastUsable - w)}`);
    assert.equal(e.learnedLate, true);
    assert.ok(e.receivedAt >= w + 5 * DAY);
    assert.ok(lastUsable < e.receivedAt, "the client stopped at the instant it learned, not at some later bound");
    assert.equal(e.deleteBy, e.receivedAt + 30 * DAY, "the deletion bound runs from first receipt");
  });

  it("a delayed answer neither extends a deadline nor starts one: use continues after a 40 h answer and an outage", async () => {
    const sim = new Sim();
    sim.sync();
    sim.responseDelayMs = 40 * HOUR;
    const s = sim.t;
    await sim.client.reconcile();
    sim.responseDelayMs = 0;
    sim.outages = [[sim.t, sim.t + 30 * DAY]];
    const { lastUsable } = await sim.runUntil(s + 10 * DAY);
    assert.equal(lastUsable, s + 10 * DAY);
  });

  it("an AS clock 3 d ahead changes nothing for use, and cannot push a stop-use bound past receipt", async () => {
    const sim = new Sim({ asSkewMs: 3 * DAY });
    sim.sync();
    await sim.client.reconcile();
    assert.equal(sim.client.canUse("g1").ok, true);
    sim.t += HOUR;
    sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" });
    await sim.client.reconcile();
    const e = sim.client.grantState("g1")?.erasures.values().next().value;
    assert.ok(e);
    // The AS stamps the instruction 3 d ahead of this client; the client cannot have learned it before
    // it applied, so the effective time is clamped to receipt and the bound cannot extend past it.
    assert.ok(e.effectiveAt <= e.receivedAt);
    assert.ok(e.stopUseBy <= e.receivedAt + 48 * HOUR);
  });

  it("C1a: two 1 h outages 24 h apart, each covering a scheduled attempt: hourly retries hit an answer within the retry interval, use never stops", async () => {
    const sim = await started();
    sim.outages = [
      [T0 + DAY - MIN, T0 + DAY + HOUR],
      [T0 + 2 * DAY - MIN, T0 + 2 * DAY + HOUR],
    ];
    const starts: number[] = [];
    const base = sim.statusCalls;
    let unusable = 0;
    while (sim.t < T0 + 5 * DAY) {
      sim.t += 5 * MIN;
      const before = sim.statusCalls;
      await sim.client.tick();
      if (sim.statusCalls > before) starts.push(sim.t);
      if (!sim.client.canUse("g1").ok) unusable += 5 * MIN;
    }
    report(`two 1 h blips at attempt times: ${sim.statusCalls - base} attempts, unusable ${h(unusable)}`);
    assert.equal(unusable, 0, "a failed attempt does not stop use the grant's terms permit");
    // After the failed attempt at T0+24h the next attempt starts within an hour of its start.
    const failed = starts.find((x) => x >= T0 + DAY);
    assert.ok(failed !== undefined);
    const next = starts.find((x) => x > failed);
    assert.ok(next !== undefined && next - failed <= HOUR, `next attempt ${h((next ?? 0) - failed)} after the failed one`);
    // Each outage ended within an hour: the retry reached an answer, and the daily cadence resumed.
    assert.ok(sim.client.nextAttemptAt !== null && sim.client.nextAttemptAt > sim.t);
  });

  it("C1a variant: a request that stays unanswered does not hold up the retry (the next attempt starts within an hour of its START)", async () => {
    let calls = 0;
    const hung = new Sim();
    // A client over the same toy store whose transport never answers.
    let t = T0;
    const client = new HeldDataClient({
      now: () => t, store: hung.app, initialize: true,
      status: () => { calls += 1; return new Promise(() => {}); },
    });
    hung.app.attach(client);
    hung.app.sync("g9", [{ id: "x", stream: "messages", text: "hi" }]);
    client.onTokenResponse({ grantIds: ["g9"], sentAt: t });
    t += DAY;
    void client.tick(); // attempt 1 starts and never returns
    assert.equal(calls, 1);
    assert.equal(client.canUse("g9").ok, true, "an unanswered attempt does not stop permitted use");
    t += HOUR - MIN;
    void client.tick();
    assert.equal(calls, 1, "not yet: the retry is owed within an hour of the previous START");
    t += MIN;
    void client.tick();
    assert.equal(calls, 2, "the next attempt starts an hour after the previous START without waiting for it to finish");
    assert.equal(client.canUse("g9").ok, true);
  });

  it("C1: first attempt due 24 h after first acquisition, and at least once per 24 h after; a successful answer restarts the interval", async () => {
    const sim = new Sim();
    sim.sync();
    const t0 = sim.t;
    assert.equal(sim.client.nextAttemptAt, t0 + DAY);
    sim.t = t0 + DAY - MIN;
    await sim.client.tick();
    assert.equal(sim.statusCalls, 0);
    sim.t = t0 + DAY;
    await sim.client.tick();
    assert.equal(sim.statusCalls, 1);
    assert.equal(sim.client.nextAttemptAt, t0 + 2 * DAY);
    // The AS is unreachable at the next due time: retries every hour, and the 24 h duty still binds.
    sim.outages = [[t0 + 2 * DAY, t0 + 4 * DAY]];
    const attempts: number[] = [];
    while (sim.t < t0 + 3 * DAY) {
      sim.t += 10 * MIN;
      const before = sim.statusCalls;
      await sim.client.tick();
      if (sim.statusCalls > before) attempts.push(sim.t);
    }
    for (let i = 1; i < attempts.length; i += 1) {
      assert.ok((attempts[i] ?? 0) - (attempts[i - 1] ?? 0) <= HOUR);
    }
    assert.ok(attempts.length >= 23);
  });

  it("C1: a client that holds no held data when the first attempt falls due owes no query", async () => {
    const sim = new Sim({ policy: { retentionCeilingMs: 12 * HOUR } });
    sim.sync();
    sim.t += 13 * HOUR;
    await sim.client.tick();
    assert.deepEqual(sim.app.holds("g1"), { records: 0, indexEntries: 0, summary: false });
    sim.t += 2 * DAY;
    const before = sim.statusCalls;
    await sim.client.tick();
    assert.equal(sim.statusCalls, before, "nothing is held, so no attempt is made");
    assert.equal(sim.client.nextAttemptAt, null);
  });

  describe("C2: queued and in-flight work observed through the toy-app adapter", () => {
    it("AS unreachable after the erasure: work keeps running (the client has not learned), and stops at once on the first answer", async () => {
      const sim = await started();
      const s = sim.t;
      sim.outages = [[s + 1, s + 3 * DAY]];
      sim.t = s + HOUR;
      sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" });
      const inFlight = sim.app.enqueue("g1", "hello");
      const queued = sim.app.enqueue("g1", "hello");
      sim.t = s + 2 * DAY;
      await sim.client.tick();
      assert.equal(sim.app.start(inFlight), true, "silence does not stop permitted use");
      sim.t = s + 3 * DAY + MIN;
      await sim.client.tick(); // the outage is over: the client learns now, past w + 48 h
      const e = sim.client.grantState("g1")?.erasures.values().next().value;
      assert.equal(e?.learnedLate, true);
      assert.equal(sim.app.finish(inFlight), null, "the in-flight job is refused when it tries to complete");
      assert.equal(sim.app.start(queued), false, "queued work is not dispatched");
      assert.deepEqual(sim.app.observations.filter((o) => o.kind === "complete" && o.at >= s + 3 * DAY), []);
      assert.ok(sim.app.observations.some((o) => o.kind === "cancel" && o.grantId === "g1" && o.at === e?.receivedAt));
    });

    it("work whose search crosses the instant of receipt is cancelled, not completed", async () => {
      const sim = await started();
      const job = sim.app.enqueue("g1", "hello");
      assert.equal(sim.app.start(job), true);
      // The gate passes at the start of the search; while the index is traversed the client learns of an erasure.
      const get = sim.app.index.get.bind(sim.app.index);
      sim.app.index.get = (word) => {
        sim.client.ownerDelete("g1");
        return get(word);
      };
      assert.equal(sim.app.finish(job), null, "no result is returned for work that finished after use stopped");
      assert.equal(job.state, "cancelled");
      assert.deepEqual(sim.app.observations.filter((o) => o.kind === "complete"), []);
    });

    it("receipt before the bound: work stops at once on receipt, on the declared clock, and nothing completes after it", async () => {
      const sim = await started();
      const inFlight = sim.app.enqueue("g1", "hello");
      assert.equal(sim.app.start(inFlight), true);
      const queued = sim.app.enqueue("g1", "hello");
      sim.t += MIN;
      const w = sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" }).acceptedAt;
      await sim.runUntil(w + 2 * DAY);
      const q = sim.client.grantState("g1")?.erasures.values().next().value?.receivedAt;
      assert.ok(q !== undefined && q <= w + 48 * HOUR, "receipt within the stop-use bound");
      const cancels = sim.app.observations.filter((o) => o.kind === "cancel").map((o) => o.at);
      assert.deepEqual(cancels, [q, q], "in-flight and queued work were cancelled at the instant of receipt");
      assert.equal(sim.app.finish(inFlight), null);
      assert.equal(sim.app.start(queued), false);
      assert.deepEqual(sim.app.observations.filter((o) => o.kind === "complete"), []);
    });
  });

  it("C4: redelivery the next day does not move the deletion deadline; a late redelivery after a 40-day power-off is overdue disposal that is recorded", async () => {
    const sim = await started({ policy: { disposeAt: "deadline" } });
    sim.t += HOUR;
    sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" });
    await sim.client.reconcile();
    const e = sim.client.grantState("g1")?.erasures.values().next().value;
    assert.ok(e);
    const q = e.receivedAt;
    sim.t += DAY;
    await sim.client.reconcile();
    assert.equal(sim.client.grantState("g1")?.erasures.values().next().value?.deleteBy, q + 30 * DAY);
    // Powered off past the deadline.
    sim.t = q + 40 * DAY;
    await sim.client.onResume();
    const after = sim.client.grantState("g1")?.erasures.values().next().value;
    assert.deepEqual(sim.app.holds("g1"), { records: 0, indexEntries: 0, summary: false });
    assert.equal(after?.overdue, true, "the missed deadline is on record");
    assert.equal(after?.disposedAt, q + 40 * DAY);
  });
});
