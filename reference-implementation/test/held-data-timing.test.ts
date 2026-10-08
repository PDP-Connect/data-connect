// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Held-data lifecycle prototype: the timing traces of converge-r1-astra §3,
 * run against the AS authority and the client library under both pause
 * thresholds (OD-4: 7 d, 48 h) and both deletion fallbacks (OD-5: 90 d
 * long-stop, off). Each test prints what it measured; the findings report
 * quotes these lines.
 *
 * Notation: `s` last positive assessment, `w` erasure acceptance, `q` the
 * client's first authenticated receipt.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DAY, HOUR, MIN, Sim, T0 } from "./helpers/held-data-sim.ts";

const THRESHOLDS = [
  { label: "OD-4 7 d", ms: 7 * DAY },
  { label: "OD-4 48 h", ms: 48 * HOUR },
];
const LONG_STOPS = [
  { label: "OD-5 90 d", ms: 90 * DAY as number | null },
  { label: "OD-5 off", ms: null },
];

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

describe("held-data timing traces (converge-r1-astra §3)", () => {
  for (const th of THRESHOLDS) {
    it(`online daily check, erasure just after a check (${th.label}): use stops within 48 h, deletion within 31 d`, async () => {
      const sim = await started({ policy: { pauseThresholdMs: th.ms, disposeAt: "deadline" } });
      sim.t = T0 + MIN;
      const w = sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" }).acceptedAt;
      const { lastUsable, lastSubUsable } = await sim.runUntil(w + 3 * DAY);
      const q = sim.client.grantState("g1")?.erasures.values().next().value?.receivedAt ?? null;
      const gone = await sim.runUntilGone(w + 60 * DAY);
      assert.ok(lastUsable !== null && q !== null && gone !== null);
      const useAfter = lastUsable - w;
      report(
        `${th.label} online: use after erasure ${h(useAfter)}; subprocessor ${h((lastSubUsable ?? w) - w)}; receipt at w+${h(q - w)}; copy gone at w+${h(gone - w)} (= ${((gone - w) / DAY).toFixed(2)} d)`
      );
      assert.ok(useAfter <= 48 * HOUR, "with the AS reachable, use stops within 48 h of acceptance");
      assert.ok(gone - w <= 31 * DAY, "deletion within q + 30 d, q <= w + 24 h");
      // The AS shows a deletion date only from the client's receipt.
      const view = sim.as.ownerView("g1", 30 * DAY);
      assert.equal(view?.erasures[0]?.receipt_at, q);
      assert.equal(view?.erasures[0]?.delete_by, q + 30 * DAY);
      assert.equal(view?.erasures[0]?.completion?.outcome, "deleted");
    });

    for (const ls of LONG_STOPS) {
      it(`AS unreachable from just after the erasure (${th.label}, ${ls.label}): use stops at s + threshold; deletion per long-stop`, async () => {
        const sim = await started({ policy: { pauseThresholdMs: th.ms, longStopMs: ls.ms } });
        const s = T0;
        sim.t = T0 + 1000;
        const w = sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" }).acceptedAt;
        sim.outages = [[w, w + 400 * DAY]];
        const { lastUsable, lastSubUsable } = await sim.runUntil(w + 10 * DAY, 15 * MIN);
        assert.ok(lastUsable !== null);
        const gone = await sim.runUntilGone(w + 365 * DAY, 6 * HOUR);
        report(
          `${th.label}, ${ls.label}, outage from w: use after erasure ${h(lastUsable - w)} (beyond w+48h: ${h(Math.max(0, lastUsable - w - 48 * HOUR))}); subprocessor ${h((lastSubUsable ?? w) - w)}; copy gone ${gone === null ? "never (checked to 365 d)" : `at s+${((gone - s) / DAY).toFixed(2)} d`}`
        );
        assert.ok(lastUsable <= s + th.ms, "use never outlasts s + threshold");
        assert.ok(lastUsable >= s + th.ms - 15 * MIN, "and lasts until then (step resolution)");
        if (ls.ms === null) {
          assert.equal(gone, null, "with no long-stop, an undelivered erasure leaves the copy (paused) indefinitely");
        } else {
          assert.ok(gone !== null && gone - s <= ls.ms + 6 * HOUR && gone - s >= ls.ms);
        }
        // Nothing was fabricated: the AS still shows the operation undelivered.
        assert.equal(sim.as.ownerView("g1", 30 * DAY)?.erasures[0]?.delivered_at, null);
        assert.equal(sim.as.ownerView("g1", 30 * DAY)?.erasures[0]?.delete_by, null);
      });
    }

    it(`delayed answer (${th.label}): an answer assessed at s and received 40 h later keeps deadline s + threshold`, async () => {
      const sim = new Sim({ policy: { pauseThresholdMs: th.ms } });
      sim.sync();
      sim.responseDelayMs = 40 * HOUR;
      const s = sim.t;
      await sim.client.reconcile();
      sim.responseDelayMs = 0;
      sim.outages = [[sim.t, sim.t + 30 * DAY]];
      const { lastUsable } = await sim.runUntil(s + 10 * DAY);
      report(`${th.label} delayed 40 h: usable until s+${h((lastUsable ?? s) - s)}`);
      assert.ok(lastUsable !== null && lastUsable <= s + th.ms);
    });
  }

  it("AS clock 3 d ahead: with the AS assessment time as freshness origin, use outlasts the threshold by the skew; the request-send origin does not", async () => {
    const results: Record<string, number> = {};
    for (const origin of ["assessed_at", "request_sent"] as const) {
      const sim = new Sim({ asSkewMs: 3 * DAY, policy: { pauseThresholdMs: 48 * HOUR, freshnessOrigin: origin } });
      sim.sync();
      const s = sim.t;
      await sim.client.reconcile();
      sim.outages = [[sim.t + 1, sim.t + 30 * DAY]];
      const { lastUsable } = await sim.runUntil(s + 10 * DAY);
      results[origin] = (lastUsable ?? s) - s;
    }
    report(
      `AS +3 d skew, 48 h threshold: origin=assessed_at usable ${h(results.assessed_at ?? 0)}; origin=request_sent usable ${h(results.request_sent ?? 0)}`
    );
    assert.ok((results.assessed_at ?? 0) > 48 * HOUR + 2 * DAY, "integration-v2 read literally: skew extends use");
    assert.ok((results.request_sent ?? 0) <= 48 * HOUR);
  });

  it("two 1 h outages 24 h apart, each covering a scheduled attempt: daily-only attempts pause use under 48 h; hourly retries do not", async () => {
    const out: string[] = [];
    for (const th of THRESHOLDS) {
      for (const retryMs of [HOUR, DAY]) {
        const sim = await started({ policy: { pauseThresholdMs: th.ms, retryMs } });
        sim.outages = [
          [T0 + DAY - MIN, T0 + DAY + HOUR],
          [T0 + 2 * DAY - MIN, T0 + 2 * DAY + HOUR],
        ];
        let pausedFor = 0;
        while (sim.t < T0 + 5 * DAY) {
          sim.t += 15 * MIN;
          await sim.client.tick();
          if (!sim.client.canUse("g1").ok) {
            pausedFor += 15 * MIN;
          }
        }
        out.push(`${th.label}/${retryMs === HOUR ? "hourly retry" : "daily only"}: paused ${h(pausedFor)}`);
        if (th.ms === 48 * HOUR && retryMs === DAY) {
          assert.ok(pausedFor > 0);
        }
        if (retryMs === HOUR) {
          assert.equal(pausedFor, 0);
        }
      }
    }
    report(`two 1 h blips at attempt times: ${out.join("; ")}`);
  });

  for (const th of THRESHOLDS) {
    for (const retry of [
      { label: "hourly retry", ms: HOUR },
      { label: "daily attempts only", ms: DAY },
    ]) {
      it(`outage tolerance (${th.label}, ${retry.label}): shortest AS outage that pauses use`, async () => {
        // Worst case: the outage starts just before a scheduled attempt.
        async function pauses(outageMs: number): Promise<boolean> {
          const sim = await started({ policy: { pauseThresholdMs: th.ms, retryMs: retry.ms } });
          const start = T0 + DAY - MIN;
          sim.outages = [[start, start + outageMs]];
          let paused = false;
          while (sim.t < start + outageMs + 3 * DAY) {
            sim.t += 30 * MIN;
            await sim.client.tick();
            if (!sim.client.canUse("g1").ok) {
              paused = true;
              break;
            }
          }
          return paused;
        }
        let lo = 0;
        let hi = th.ms + DAY;
        while (hi - lo > HOUR) {
          const mid = Math.floor((lo + hi) / 2 / HOUR) * HOUR;
          if (await pauses(mid)) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        const weekend = await pauses(63 * HOUR);
        report(
          `${th.label}, ${retry.label}: worst-case outage that pauses use ~${h(hi)}; a 63 h (Fri 18:00 to Mon 09:00) desktop-AS sleep ${weekend ? "PAUSES" : "does not pause"} use`
        );
        assert.ok(hi <= th.ms);
      });
    }
  }
});
