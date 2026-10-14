// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Six held-data journeys walked against the final v0.1.0 Core text
 * (`/home/tnunamak/.tmp/held-data-v010/core-final.md`, spec-core.md at 9c64a99322; the line numbers
 * below are that file's). Each journey is a script with an injected clock over the real AS app over
 * HTTP, a public client built from the client library and the toy app, and a network the script can
 * cut. Each step asserts what the text requires and prints, as `[Jn] label: json`, what actually
 * happened.
 *
 * Verdicts (MATCH: the text was followed and the outcome is as the text describes. SURPRISE: the text
 * was followed but the outcome would surprise an owner, patient, clinician or implementer. BREAK: the
 * text cannot be followed, contradicts itself, or the prototype cannot follow it) are in the block
 * above each describe. PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HeldDataAuthority } from "../lib/held-data/authority.ts";
import { exchangeOAuthRefreshToken, introspect } from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { getHeldDataRuntime, installHeldDataRuntime } from "../server/held-data/runtime.ts";
import { RESTORED_STATEMENT } from "../server/held-data/owner-statements.ts";
import { form, lifecycle, owner } from "./helpers/held-data-as-http.ts";
import { DAY, HOUR, MIN, type Call, journey, type World } from "./helpers/held-data-journeys.ts";
import { fetchJson } from "./helpers/training-lease-harness.ts";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

const note = (j: number, label: string, data: unknown) => console.log(`[J${j}] ${label}: ${JSON.stringify(data)}`);
const gaps = (calls: Call[]) => calls.slice(1).map((c, i) => c.at - (calls[i] as Call).at);
const days = (ms: number) => Math.round((ms / DAY) * 100) / 100;
const hours = (ms: number) => Math.round((ms / HOUR) * 100) / 100;

/*
 * SPEC FINDINGS (line = core-final.md; each is a proposal, not a decision)
 *
 * S1 line 1485 vs 1495. "A backup restore or a failover MUST NOT make any enforcement point act on a
 *    history that omits an acknowledged terminal event" has no qualification, yet 1495 lets an AS
 *    declare a mechanism that does not detect "a revert of a virtual-machine snapshot", which does
 *    exactly that (J4b). Proposed: end 1485 with "...by a restore or failover that the AS's declared
 *    mechanism detects; 1495 states what it does not detect".
 * S2 line 1342 (Overdue disposal). It sits in Erasure and says "a deletion deadline". 1256 says "any
 *    overdue disposal" and 1516 says "no further grace period" for retention ceilings. Say whether a
 *    missed retention ceiling must be recorded too (J3c). Proposed: "A client that misses a deletion
 *    deadline or a retention ceiling...".
 * S3 line 1346 with 1478 and 1310. An instruction that takes effect while the grant is active revokes
 *    it (1310), so a public client's tokens never authenticate its `received` report (1386); every
 *    public client needs the owner's approval of lifecycle recovery just to report receipt, and the
 *    owner sees no deletion date until it gets one (J1, J5). The recovery token "MAY" expire (1478),
 *    so completion by a client that deletes at its deadline needs another approval 30 days later
 *    (J5b, J6b). Proposed: say an AS SHOULD give a recovery token a lifetime of at least the deletion
 *    bound, and that a client SHOULD retry a refused report after the owner next approves recovery.
 * S4 line 1297 and 1306. The retry duty has no relief for an unreachable host: 2,378 hourly requests in
 *    100 days (J1). The SHOULD-backoff is "capped at the retry interval", which is also the maximum.
 *    Proposed: after the grant's terms stop depending on an answer, or after N consecutive transport
 *    failures, allow the retry interval to widen to the reconciliation interval.
 * S5 line 1297. "Holds any held data of a grant" keeps the daily query going for legally retained data
 *    and for data waiting for its deletion deadline, though an accepted instruction is terminal (1312)
 *    and the AS can tell the client nothing new (J6: 120 queries in 120 days). Proposed: the duty ends
 *    once the client has received an erasure instruction for the grant.
 * S6 line 1350. The statement tells the owner "it tries daily". After a failed attempt the text makes
 *    it try hourly (1306). Proposed: "tries at least daily, and hourly after a failed try".
 *
 * UNVERIFIED: a real network and TLS (the AS and the client share one process; "offline" is a cut in
 * the client's fetch); wall-clock skew between AS and client (one injected clock drives both);
 * confidential-client authentication; DPoP-bound tokens; the RS side of a restore (the RS reads the
 * same database); Postgres storage; downstream holders (J1-J6 use no subprocessor).
 */

/* ------------------------------------------------------------------------------------------------
 * JOURNEY 1: the patient's desktop AS is offline for 8 days, and for 100 days, while the doctor's app
 * runs. The app holds data under an active grant with a positive assessment (a token response).
 *
 * Spec lines: 1295 (silence is not an instruction; keep and MAY continue to use), 1297 (first attempt
 * due 24 h after first acquisition; no held data, no further query), 1304 (failed attempt does not
 * stop use; every known deadline still binds), 1306 (retry within 1 h of the preceding attempt's
 * start until one succeeds), 1253/1331 (stop use at once if learned after the stop-use bound), 1338
 * (deletion bound from first receipt), 1352 (no deletion date until a receipt is reported), 1346 (a
 * public client usually cannot report after the grant ends; asks the owner for lifecycle recovery),
 * 1514/1516 (retention ceiling per record, no grace).
 *
 * VERDICT: SURPRISE (text followed in every cell; details at the end of each test).
 *   - The attempt arithmetic is exactly as the text says: first attempt at +24 h, then one every hour:
 *     170 failed attempts in 8 days, 2,378 in 100 days with no retention, 2,136 with P90D (the client
 *     holds nothing after day 90 and owes no query). Who is surprised: an implementer (a desktop AS
 *     on a home network is hit hourly for months; the text's only relief is Retry-After, which an
 *     unreachable host cannot send, and the SHOULD-backoff is capped at the same 1 h).
 *   - Use never pauses: the app uses the data for the whole outage, including for the 100 days after
 *     the owner chose `delete` before the outage began. The patient is told this in the owner
 *     statements (1350), but a patient who pressed "delete" on day 0 and finds the app used the data
 *     until day 100 is surprised, and so is a clinician who assumes the delete took effect.
 *   - A public client whose grant was ended by the delete cannot report the receipt (its tokens no
 *     longer authenticate writes, 1386). The owner sees "Sent ...; no receipt reported. No deletion
 *     date applies yet." for as long as the app does not ask the owner for lifecycle recovery. The
 *     text says the client SHOULD ask at the owner's next interaction (1346); a patient who never
 *     meets the app again sees no deletion date, ever.
 * ---------------------------------------------------------------------------------------------- */
describe("J1: AS offline while the app runs", () => {
  type Ending = "unchanged" | "owner-deleted-before-outage" | "owner-deletes-on-return";
  const cases: { offlineDays: number; retention: string | undefined; ending: Ending }[] = [];
  for (const offlineDays of [8, 100]) {
    for (const retention of [undefined, "P90D"]) {
      for (const ending of ["unchanged", "owner-deleted-before-outage", "owner-deletes-on-return"] as Ending[]) {
        cases.push({ offlineDays, retention, ending });
      }
    }
  }

  for (const c of cases) {
    it(`${c.offlineDays} days offline, retention ${c.retention ?? "none"}, AS returns: ${c.ending}`, async () => {
      await journey(
        { retention: c.retention, policy: { disposeAt: "deadline" } },
        async (w) => {
          const label = `${c.offlineDays}d/${c.retention ?? "no-retention"}/${c.ending}`;
          const t0 = w.clock.now;
          const outageStart = t0 + 2 * HOUR;
          const outageEnd = outageStart + c.offlineDays * DAY;
          w.firstSync();
          assert.equal(w.use(), true, "first use needs a positive assessment, and the token response is one");
          const ceiling = c.retention ? t0 + 90 * DAY : null;
          assert.equal(w.client.deleteBy(w.grantId), ceiling, "the only deadline the client knows is the retention ceiling");
          note(1, `${label} deadlines at the start`, {
            first_attempt_day: 1, then: "hourly while unanswered, daily once answered",
            retention_ceiling_day: ceiling === null ? null : 90, erasure_deadlines: "none until an instruction is received",
          });

          let deletedAt: number | null = null;
          if (c.ending === "owner-deleted-before-outage") {
            w.clock.now = t0 + HOUR;
            await w.ownerErase();
            deletedAt = w.clock.now;
            const rec = await w.ownerRecord();
            assert.equal(rec.erasures[0].stages.latest, "requested");
            assert.equal(rec.erasures[0].delete_by, null, "no deletion date from acceptance");
          }
          w.outages.push([outageStart, outageEnd]);

          // The AS is offline. Step through it; the app tries to use the data at every step.
          await w.advance(outageEnd - HOUR);
          const failed = w.queries().filter((q) => q.status === 0);
          const expectedFailed = c.retention && c.offlineDays === 100 ? 90 * 24 - 24 : c.offlineDays * 24 - 22;
          // 8 days: attempts at +24h, +25h ... up to the last hour before the AS returns.
          note(1, `${label} failed attempts before return`, { count: failed.length, expectedFailed });
          assert.equal(failed.length, expectedFailed);
          assert.equal((failed[0] as Call).at, t0 + DAY, "the first attempt is due 24 h after first acquisition");
          assert.ok(gaps(failed).every((g) => g === HOUR), "after a failed attempt, the next starts within the retry interval");
          assert.equal(w.queries().every((q) => q.status === 0), true, "nothing was answered");

          const usedAllOutage = w.useLog.every((u) => u.ok || (ceiling !== null && u.at >= ceiling));
          note(1, `${label} use during the outage`, { transitions: w.useLog.map((u) => ({ ...u, day: days(u.at - t0) })) });
          assert.equal(usedAllOutage, true, "unreachability stops no use that the grant's terms still permit");
          if (c.retention && c.offlineDays === 100) {
            const last = w.useLog[w.useLog.length - 1];
            assert.equal(last?.ok, false);
            assert.equal(last?.at, ceiling, "the retention ceiling binds with the AS offline: disposed on day 90");
            assert.equal(w.app.holds(w.grantId).records, 0);
            assert.equal(w.client.nextAttemptAt, null, "no held data, so no further query is owed (1297)");
          }

          // The AS returns.
          w.clock.now = outageEnd - HOUR;
          if (c.ending === "owner-deletes-on-return") {
            w.clock.now = outageEnd;
            await w.ownerErase();
            deletedAt = w.clock.now;
            // The attempt that fell due at `outageEnd` starts on the next step.
          }
          await w.advance(outageEnd + 2 * HOUR, 30 * MIN);
          const after = w.queries(outageEnd - HOUR + 1);
          note(1, `${label} first calls after return`, after.slice(0, 3).map((q) => ({ ...q, h: hours(q.at - outageEnd) })));

          const holdsNothing = Boolean(c.retention) && c.offlineDays === 100;
          if (holdsNothing) {
            assert.equal(after.filter((q) => q.status === 200).length, 0, "an app that holds nothing owes no query, so the AS is never asked");
            if (c.ending !== "unchanged") {
              const rec = await w.ownerRecord();
              note(1, `${label} owner view`, { stage: rec.erasures[0].stages.latest, delete_by: rec.erasures[0].delete_by });
              assert.equal(rec.erasures[0].stages.latest, "requested", "the instruction was never sent: the app held nothing and did not ask");
            }
            return;
          }

          const answered = after.find((q) => q.status === 200);
          assert.ok(answered, "the AS answers once it is back");
          assert.ok((answered as Call).at - outageEnd <= HOUR, "the first attempt after the outage lands within the retry interval");
          if (c.ending === "unchanged") {
            assert.equal(answered?.held, "permitted");
            assert.equal(w.use(), true);
            const next = w.client.nextAttemptAt as number;
            assert.equal(next - (answered as Call).at, DAY, "a success ends the retries and the interval is 24 h again");
            return;
          }
          // A delete reached the app.
          assert.equal(answered?.held, "erase");
          const e = w.client.grantState(w.grantId)?.erasures.values().next().value;
          assert.ok(e);
          note(1, `${label} client record`, {
            effective_day: days(e.effectiveAt - t0),
            stop_use_by_day: days(e.stopUseBy - t0),
            received_day: days(e.receivedAt - t0),
            learned_late: e.learnedLate,
            use_stopped_at_receipt: e.stoppedUseAt === e.receivedAt,
            delete_by_day: days(e.deleteBy - t0),
            days_of_use_after_owner_chose_delete: days(e.receivedAt - (deletedAt as number)),
          });
          assert.equal(e.effectiveAt, deletedAt);
          assert.equal(e.stoppedUseAt, e.receivedAt, "use stops at receipt");
          assert.equal(e.deleteBy, e.receivedAt + 30 * DAY, "the deletion bound runs from first receipt");
          assert.equal(w.use(), false);
          assert.equal(e.learnedLate, e.receivedAt > e.stopUseBy, "learned late: stop at once, not at stop_use_by");
          if (c.ending === "owner-deleted-before-outage") {
            assert.equal(e.learnedLate, true);
          }
          // The AS side: sent, no receipt (the public client's tokens ended with the grant).
          const rec = await w.ownerRecord();
          const er = rec.erasures[0];
          note(1, `${label} owner view`, { stages: er.stages.latest, delete_by: er.delete_by, message: String(er.owner_message).slice(0, 90) });
          assert.equal(er.stages.latest, "sent");
          assert.equal(er.delete_by, null, "no deletion date until a receipt is reported");
          assert.equal(w.writes().length, 0, "a public client with no current authentication cannot report");
        },
      );
    });
  }
});

/* ------------------------------------------------------------------------------------------------
 * JOURNEY 2: the owner chooses `delete` at the AS, then the AS dies for good before the client
 * receives it.
 *
 * Spec lines: 1272 (decommission: offer a disposition for every grant, show each as offered,
 * recorded, sent or receipt reported, warn about each delete no client has received), 1350 (owner
 * statements, including "if the AS stops answering for good before the client receives the
 * instruction, the client may keep and use the data until the grant's retention ceiling, or
 * indefinitely when the grant states no retention limit"), 1352 (stages; no deletion date until a
 * receipt is reported), 1304 (a failed query does not stop permitted use), 1301 (a read failure
 * starts a query before further use; it need not succeed).
 *
 * VERDICT: SURPRISE (text followed; the AS says it in advance and the app does what it says).
 *   - The owner is shown the statements and the stage "requested" (then "recorded" in the decommission
 *     flow), no deletion date, and a warning that a delete no client has received cannot be
 *     delivered once the AS stops answering.
 *   - The app learns the grant is dead (the RS answers 401; the client starts a query as 1301
 *     requires) and still keeps using the data: 90 days to the retention ceiling, or for as long as
 *     the app exists when the grant states no retention (400 days walked). Who is surprised: the
 *     patient and the clinician. The patient pressed delete and was warned; the clinician's app
 *     holds a refused-read grant and keeps serving the data, lawfully.
 *   - Two wording defects in the AS's statements (prototype, not Core): with no retention limit the
 *     sentence reads "...for the approved purpose until no time limit, because the grant states no
 *     retention limit" (Core's example: "or with no time limit if it stated none"); and every
 *     statement says the app "tries daily", though after one failed attempt the text makes it try
 *     hourly (1306), which is 24 times as many requests as the owner is told.
 * ---------------------------------------------------------------------------------------------- */
describe("J2: the owner deletes, then the AS dies for good", () => {
  const required = [
    /Scope: all data the app holds under this grant/,
    /Exceptions: .*learned under valid processing authority.*non-identifiable.*independently under another grant.*law requires/,
    /stop using covered data as soon as practicable after it receives this request: by \S+ if it receives it by then, and at once if it receives it later/,
    /delete covered data within 30 days of receiving the request/,
    /learns of this request only when it gets an answer from your server/,
    /it tries daily to check with your server, but a try is not a received request/,
    /An app that is not running does not check/,
    /If your server is offline, the app cannot learn of the request until your server answers, and there is no maximum delay/,
    /deleting inside it binds the app at once\. That is an instruction, not instant physical deletion/,
    /duties of conforming apps, not proof of remote deletion/,
  ];

  it("through decommission, retention P90D: warned, recorded, never sent; the app keeps using until day 90", async () => {
    await journey({ retention: "P90D", policy: { disposeAt: "deadline" } }, async (w, h) => {
      const t0 = w.clock.now;
      w.firstSync();
      assert.equal(w.use(), true);
      w.clock.now = t0 + HOUR;

      // Before the AS stops answering for good: the offer lists the grant with both choices and a warning.
      const offer = await owner(h, "/v1/owner/lifecycle/decommission");
      assert.equal(offer.status, 200, JSON.stringify(offer.body));
      const og = (offer.body.grants as Record<string, any>[]).find((g) => g.grant_id === w.grantId);
      assert.ok(og, "every grant whose held data may remain is offered");
      assert.deepEqual(og.choices, ["keep", "delete"], "neither is preselected");
      assert.equal(og.stage, "offered");
      assert.match(og.delete_warning, /Once this server stops answering, an app that has not received it cannot learn of it/);
      note(2, "decommission offer", { stage: og.stage, owner_message: String(offer.body.owner_message).slice(0, 120) });

      const done = await fetchJson<Record<string, any>>(`${h.asUrl}/v1/owner/lifecycle/decommission`, {
        method: "POST",
        headers: { Authorization: `Bearer ${h.ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ offer_id: offer.body.offer_id, dispositions: { [w.grantId]: "delete" } }),
      });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      const result = done.body.grants[0];
      note(2, "decommission result", result);
      assert.equal(result.stage, "recorded");
      assert.match(result.warning, /has not been received by the app, and it cannot be delivered now that this server has stopped answering/);

      const rec = await w.ownerRecord();
      const er = rec.erasures[0];
      const text = (er.statements as string[]).join("\n");
      for (const r of required) assert.match(text, r);
      note(2, "statements shown to the owner", er.statements);
      assert.match(text, /until each record's retention ceiling \(the app's first acquisition of the record plus P90D\)/);
      assert.equal(er.stages.latest, "requested", "the latest recorded stage is shown");
      assert.equal(er.delete_by, null, "no receipt-based deletion date");
      assert.match(er.owner_message, /^Requested on \S+; not yet sent\. No deletion date applies yet\./);
      assert.equal(er.stop_use_by, w.iso(Date.parse(er.effective_at) + 48 * HOUR), "stop-use date measured from the effective time");

      // The RS now refuses reads under the grant. The app notices and starts a query; the AS is gone.
      assert.notEqual(await w.rsStatus(), 200, "the RS refuses reads under a revoked grant");
      w.outages.push([w.clock.now, Infinity]);
      await w.client.onReadFailure(w.grantId);
      assert.equal(w.queries().length, 1, "the failure-triggered attempt started");
      assert.equal(w.queries()[0]?.status, 0);
      assert.equal(w.use(), true, "the attempt failed; the grant's terms still permit use (1304)");

      await w.advance(t0 + 90 * DAY - HOUR);
      assert.equal(w.use(), true, "one hour before the ceiling the app still uses the data");
      await w.advance(t0 + 90 * DAY);
      assert.equal(w.use(), false);
      const last = w.useLog[w.useLog.length - 1];
      note(2, "end of use", { day: days((last?.at ?? 0) - t0), reason: last?.reason, attempts: w.queries().length, answered: w.queries().filter((q) => q.status !== 0).length });
      assert.equal(last?.at, t0 + 90 * DAY);
      assert.equal(w.queries().filter((q) => q.status !== 0).length, 0, "never answered");
      assert.equal(w.app.holds(w.grantId).records, 0, "the retention ceiling disposes with no grace");
    });
  });

  it("an ordinary delete, no retention limit: the AS never returns, the app uses the data for 400 days and says so in its records", async () => {
    await journey({ policy: { disposeAt: "deadline" } }, async (w) => {
      const t0 = w.clock.now;
      w.firstSync();
      w.clock.now = t0 + HOUR;
      const erased = await w.ownerErase();
      assert.equal(erased.erasures[0].stages.latest, "requested");
      const text = (erased.erasures[0].statements as string[]).join("\n");
      for (const r of required) assert.match(text, r);
      assert.match(text, /no time limit, because the grant states no retention limit/);
      // Prototype wording defect: the sentence reads "...for the approved purpose until no time limit, because...".
      // Core's example says "or with no time limit if it stated none".
      assert.match(text, /until no time limit/, "UNVERIFIED-BY-DESIGN: records the garbled wording as it is");
      w.outages.push([w.clock.now, Infinity]);
      await w.advance(t0 + 400 * DAY);
      assert.equal(w.useLog.every((u) => u.ok), true, "400 days of use, none refused");
      assert.equal(w.client.deleteBy(w.grantId), null, "no deadline of any kind");
      note(2, "no-retention walk", { days: 400, attempts: w.queries().length, answered: w.queries().filter((q) => q.status !== 0).length });
    });
  });
});

/* ------------------------------------------------------------------------------------------------
 * JOURNEY 3: the app is powered off for 30 days, then resumes.
 *
 * Spec lines: 1256 ("A client MUST count time spent suspended or powered off"; before further use it
 * MUST establish whether disposal is overdue and complete it), 1302/1306 (on resume after an attempt
 * fell due, start a query before further use), 1304 (an attempt, not a success), 1331 (stop at once on
 * a late receipt), 1338 (deletion bound from first receipt), 1342 (overdue disposal: complete before
 * any further use, record the missed deadline, never report it as on time), 1516 (retention ceiling,
 * no grace).
 *
 * VERDICT: MATCH for (a) and (b) and (e); SURPRISE for (d); (c) is MATCH on behaviour and BREAK on the
 * record.
 *   (a) one query is started before the first use, nothing else: MATCH.
 *   (b) the delete effective on day 2 is learned on day 30: late (stop_use_by was day 4), use stops at
 *       receipt, deletion is due 30 days from the receipt (day 60), not from day 2: MATCH. An
 *       implementer may be surprised that a delete chosen on day 2 yields deletion on day 60 at the
 *       latest, but the text says exactly that (1338, 1350).
 *   (c) the ceiling (day 20) passed while off: the data is disposed before the gate answers; nothing
 *       is queried. The text asks for the missed deadline to be recorded (1342), but 1342 sits in
 *       Erasure and speaks of "a deletion deadline"; the prototype records a missed *erasure*
 *       deadline (`overdue`) and for a retention ceiling records only the disposal time and reason.
 *       The missed deadline is derivable (ceiling = acquisition + max_duration) but not recorded.
 *       SPEC FINDING: say whether 1342 covers retention ceilings.
 *   (d) the AS is unreachable at resume: the attempt starts and fails, and the app uses the data. The
 *       delete the owner chose on day 2 does not stop it. The text is explicit (1295, 1304): SURPRISE.
 *   (e) a deadline known before power-off is overdue at resume: disposal completes inside the first
 *       gate check, the record says overdue, and the completion report carries the true completion
 *       time: MATCH.
 * ---------------------------------------------------------------------------------------------- */
describe("J3: the app is powered off for 30 days", () => {
  it("(a) no instruction meanwhile: one attempt starts before the first use, and a failed one would not stop it", async () => {
    await journey({}, async (w) => {
      const t0 = w.clock.now;
      w.firstSync();
      await w.advance(t0 + HOUR);
      assert.equal(w.queries().length, 0, "nothing was due in the first hour");
      // Powered off: no ticks, no clock reads by the app.
      w.clock.now = t0 + 30 * DAY;
      const c2 = w.restart();
      assert.deepEqual(c2.canUse(w.grantId), { ok: false, reason: "reconcile_required" }, "an attempt fell due while off");
      assert.equal(w.app.search(w.grantId, "hello"), null, "the app cannot use the data yet");
      assert.equal(w.queries().length, 0);
      await c2.onResume();
      note(3, "(a) resume", { queries: w.queries(), use: c2.canUse(w.grantId) });
      assert.equal(w.queries().length, 1, "exactly one attempt, started before use");
      assert.equal(w.queries()[0]?.held, "permitted");
      assert.equal(c2.canUse(w.grantId).ok, true);
      assert.notEqual(w.app.search(w.grantId, "hello"), null);
      assert.equal((c2.nextAttemptAt as number) - w.clock.now, DAY, "the interval restarts from the answered attempt");
    });
  });

  it("(b) a delete became effective on day 2: learned on resume, late, stop at once, 30 days from receipt", async () => {
    await journey({ policy: { disposeAt: "deadline" } }, async (w) => {
      const t0 = w.clock.now;
      w.firstSync();
      await w.advance(t0 + HOUR);
      w.clock.now = t0 + 2 * DAY;
      await w.ownerErase(); // while the app is off
      w.clock.now = t0 + 30 * DAY;
      const c2 = w.restart();
      assert.deepEqual(c2.canUse(w.grantId), { ok: false, reason: "reconcile_required" });
      await c2.onResume();
      const e = c2.grantState(w.grantId)?.erasures.values().next().value;
      assert.ok(e);
      note(3, "(b) record", {
        effective_day: days(e.effectiveAt - t0), stop_use_by_day: days(e.stopUseBy - t0), received_day: days(e.receivedAt - t0),
        learned_late: e.learnedLate, use_stopped_day: days(e.stoppedUseAt - t0), delete_by_day: days(e.deleteBy - t0),
      });
      assert.equal(e.effectiveAt, t0 + 2 * DAY);
      assert.equal(e.stopUseBy, t0 + 4 * DAY);
      assert.equal(e.receivedAt, t0 + 30 * DAY);
      assert.equal(e.learnedLate, true);
      assert.equal(e.stoppedUseAt, e.receivedAt, "stop at once");
      assert.equal(e.deleteBy, t0 + 60 * DAY, "the deletion bound runs from the first receipt");
      assert.equal(e.overdue, false);
      assert.deepEqual(c2.canUse(w.grantId), { ok: false, reason: "erased" });
      assert.equal(w.app.search(w.grantId, "hello"), null);
      assert.equal(w.app.holds(w.grantId).records, 2, "policy 'deadline': the copy may stay until day 60 but may not be used");
      // The AS recorded when it first sent the instruction.
      const er = (await w.ownerRecord()).erasures[0];
      assert.equal(er.delivered_at, w.iso(t0 + 30 * DAY));
      assert.equal(er.accepted_at, w.iso(t0 + 2 * DAY));
    });
  });

  it("(c) a record's retention ceiling passed while off: disposal completes before the gate answers, with nothing queried", async () => {
    await journey({ retention: "P20D" }, async (w) => {
      const t0 = w.clock.now;
      w.firstSync();
      await w.advance(t0 + HOUR);
      w.clock.now = t0 + 30 * DAY;
      const c2 = w.restart();
      const d = c2.canUse(w.grantId);
      assert.deepEqual(d, { ok: false, reason: "deleted" }, "overdue disposal is complete before the gate answers (1256)");
      assert.deepEqual(w.app.holds(w.grantId), { records: 0, indexEntries: 0, summary: false });
      await c2.onResume();
      assert.equal(w.queries().length, 0, "no held data of the grant, so no query is owed (1297)");
      const g = c2.grantState(w.grantId);
      note(3, "(c) record of the missed deadline", {
        ceiling_day: 20, disposed_day: days((g?.deletedAt ?? 0) - t0), reason: g?.deleteReason,
        explicit_overdue_flag: Object.hasOwn(g ?? {}, "overdue"), events: c2.events.map((x) => x.kind),
      });
      assert.equal(g?.deletedAt, t0 + 30 * DAY);
      assert.equal(g?.deleteReason, "retention_ceiling");
      // 1342 asks the client to "record the missed deadline". For a retention ceiling the prototype keeps
      // only the disposal time and reason; the missed ceiling (day 20) is derivable, not recorded.
      const recordsMissedRetentionDeadline = Object.hasOwn(g ?? {}, "overdue") || c2.events.some((x) => /overdue|missed/.test(`${x.kind}${x.detail ?? ""}`));
      assert.equal(recordsMissedRetentionDeadline, false, "UNVERIFIED-BY-DESIGN: records no explicit missed retention deadline");
    });
  });

  it("(d) the AS is unreachable at resume: the attempt starts, fails, and the app uses the data", async () => {
    await journey({}, async (w) => {
      const t0 = w.clock.now;
      w.firstSync();
      await w.advance(t0 + HOUR);
      w.clock.now = t0 + 2 * DAY;
      await w.ownerErase();
      w.clock.now = t0 + 30 * DAY;
      w.outages.push([t0 + 30 * DAY, t0 + 33 * DAY]);
      const c2 = w.restart();
      assert.equal(c2.canUse(w.grantId).ok, false, "reconcile_required until the attempt starts");
      await c2.onResume();
      assert.equal(w.queries().length, 1);
      assert.equal(w.queries()[0]?.status, 0);
      assert.equal(c2.canUse(w.grantId).ok, true, "the attempt was made; the AS could not be reached; use goes on");
      assert.notEqual(w.app.search(w.grantId, "hello"), null);
      // Three more days: the owner chose delete 31 days before the end of this walk; the app still uses the data.
      await w.advance(t0 + 33 * DAY - HOUR);
      assert.equal(w.useLog[w.useLog.length - 1]?.ok, true);
      const failedRetries = w.queries().filter((q) => q.status === 0).length;
      await w.advance(t0 + 33 * DAY + 2 * HOUR);
      const e = c2.grantState(w.grantId)?.erasures.values().next().value;
      note(3, "(d) outcome", {
        failed_attempts_while_unreachable: failedRetries,
        use_ended_day: days((e?.stoppedUseAt ?? 0) - t0),
        days_of_use_after_the_owner_chose_delete: days((e?.stoppedUseAt ?? 0) - (t0 + 2 * DAY)),
      });
      assert.ok(e && e.learnedLate);
      assert.equal(c2.canUse(w.grantId).ok, false);
    });
  });

  it("(e) a deletion deadline known before power-off is overdue at resume: completed before use, recorded as missed, reported with its true time", async () => {
    await journey(
      { policy: { disposeAt: "deadline" }, runtime: { recoveryTokenTtlMs: 400 * DAY } },
      async (w) => {
        const t0 = w.clock.now;
        w.firstSync();
        await w.advance(t0 + HOUR);
        await w.ownerErase();
        await w.recover(); // so the public client can report
        await w.advance(t0 + 25 * HOUR);
        await w.settle();
        const got = w.client.grantState(w.grantId)?.erasures.values().next().value;
        assert.ok(got);
        const deleteBy = got.deleteBy;
        assert.equal(deleteBy, t0 + DAY + 30 * DAY, "received at the first due attempt, +24 h");
        const opId = [...(w.client.grantState(w.grantId)?.erasures.keys() ?? [])][0];
        assert.equal(w.app.holds(w.grantId).records, 2, "policy 'deadline': held until the deadline");
        let rec = (await w.ownerRecord()).erasures[0];
        assert.equal(rec.stages.latest, "receipt_reported");
        assert.equal(Date.parse(rec.delete_by), deleteBy);
        // Powered off from day 1 until day 45.
        w.clock.now = t0 + 45 * DAY;
        const c2 = w.restart();
        assert.deepEqual(c2.canUse(w.grantId), { ok: false, reason: "deleted" });
        assert.equal(w.app.holds(w.grantId).records, 0, "overdue disposal completed inside the first gate check");
        await w.settle();
        const e = c2.grantState(w.grantId)?.erasures.get(opId as string);
        note(3, "(e) record", { delete_by_day: days(deleteBy - t0), disposed_day: days((e?.disposedAt ?? 0) - t0), overdue: e?.overdue, days_late: days((e?.disposedAt ?? 0) - deleteBy) });
        assert.equal(e?.overdue, true, "the missed deadline is on record");
        assert.equal(e?.disposedAt, t0 + 45 * DAY);
        rec = (await w.ownerRecord()).erasures[0];
        assert.equal(rec.stages.latest, "completed");
        assert.equal(rec.completion.at, w.iso(t0 + 45 * DAY), "completion is reported with the true time, not the deadline");
        assert.ok(Date.parse(rec.completion.at) > Date.parse(rec.delete_by), "the owner can see it was late; the AS does not flag it");
      },
    );
  });
});

/* ------------------------------------------------------------------------------------------------
 * JOURNEY 4: the AS is restored from an old snapshot.
 *
 * Spec lines: 1485 (a backup restore or failover MUST NOT make any enforcement point act on a history
 * that omits an acknowledged terminal event), 1488/1491/1492 (history that cannot be shown current:
 * no positive assessment, no credential, 503 temporarily_unavailable with Retry-After; an `erase`
 * answer MAY come from it only for a complete instruction durably effective before), 1493 (owner
 * actions still accepted, shown recorded and pending), 1495 (the AS describes its mechanism, the
 * losses it does not survive, and says an undetected rollback such as a VM snapshot revert can revive
 * revoked grants and lose recorded deletions), 1301 (read failure starts a query), 1304.
 *
 * VERDICT: (a) SURPRISE; (b) SURPRISE, plus a SPEC FINDING about 1485 against 1495.
 *   (a) declared mechanism (invalidation on restore): detected. The AS gives 503 + Retry-After for the
 *       grant and no positive assessment; RS reads are refused. The owner's grant page shows "restored,
 *       not yet re-established". Surprise for the clinician/implementer: fail-closed at the AS is
 *       invisible to the app. A 503 is a failed attempt; the app keeps using the data for as long as
 *       the AS stays in that state (walked: 3 days, 70 hourly 503s, no use stopped), though the
 *       owner's acknowledged delete is lost from the history. The delete reaches the app only after
 *       the owner repeats it (the AS may return a recorded erasure at once) or the operator
 *       re-establishes the grant's facts.
 *   (b) undeclared path (VM snapshot revert, journal and database together): nothing is detected. The
 *       recorded deletion is gone, the grant is active again, the refresh token works, the RS serves
 *       reads, and the lifecycle answer is `permitted` (a positive assessment for a grant the owner
 *       deleted). The owner's grant page shows an active grant and no instruction. The durability
 *       statement names the path before and after. A client that had already received the
 *       instruction stays erased (erasure is terminal at the client); a client that had not is told
 *       `permitted`.
 *   SPEC FINDING: 1485 says a backup restore MUST NOT make any enforcement point act on a history that
 *   omits an acknowledged terminal event, without qualification, and 1495 then allows an AS to
 *   declare a mechanism that does not detect a VM snapshot revert. A reader can follow 1495 and
 *   breach 1485. Fix: say in 1485 "...by a restore the AS's declared mechanism detects", or move the
 *   admission of undetected paths into 1485 itself.
 * ---------------------------------------------------------------------------------------------- */
describe("J4: the AS is restored from an old snapshot", () => {
  const restoreGrantRows = (grantId: string) => {
    getDb().prepare("UPDATE grants SET status = 'active', consumed = 0 WHERE grant_id = ?").run(grantId);
    getDb().prepare("UPDATE tokens SET revoked = 0 WHERE grant_id = ?").run(grantId);
    getDb().prepare("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?").run(grantId);
  };
  const snapshotJournal = (w: World) => {
    const rt = getHeldDataRuntime()!;
    const snapshot = join(mkdtempSync(join(tmpdir(), "pdpp-held-j4-")), "snapshot");
    copyFileSync(rt.authority.journalPath, snapshot);
    return { rt, snapshot, now: () => w.clock.now };
  };

  it("(a) declared mechanism: fails closed, pending re-establishment, and the app never learns", async () => {
    await journey({ runtime: { restoreMechanism: "invalidate_on_restore" } }, async (w, h) => {
      const t0 = w.clock.now;
      w.firstSync();
      await w.client.reconcile();
      assert.equal(w.queries()[0]?.held, "permitted", "a real positive assessment before the incident");
      const { rt, snapshot, now } = snapshotJournal(w);
      await w.advance(t0 + 2 * HOUR);
      const erased = await w.ownerErase();
      assert.equal(erased.erasures[0].stages.latest, "requested", "acknowledged to the owner");
      assert.notEqual(await w.rsStatus(), 200);
      // The operator restores the snapshot through the declared procedure; the main database reverts too.
      w.clock.now = t0 + 3 * HOUR;
      HeldDataAuthority.restoreFromSnapshot({ journalPath: rt.authority.journalPath, snapshotPath: snapshot, now });
      installHeldDataRuntime({ ...rt, authority: HeldDataAuthority.open({ journalPath: rt.authority.journalPath, now }) });
      restoreGrantRows(w.grantId);

      const rec = await w.ownerRecord();
      note(4, "(a) owner view after restore", { history_state: rec.history_state, erasures: rec.erasures.length, message: String(rec.owner_message).slice(0, 80) });
      assert.equal(rec.history_state, "restored_not_current");
      assert.equal(rec.owner_message, RESTORED_STATEMENT);
      assert.equal(rec.erasures.length, 0, "the acknowledged delete is not in the restored history");
      assert.match(rec.durability, /invalidation on restore \(one store, no outside witness\)/);

      // Fail closed: lifecycle 503 with Retry-After, no refresh, no active introspection, no read.
      const q = await fetch(`${h.asUrl}/oauth/grant-lifecycle`, form({ grant_id: w.grantId, token: w.refreshToken }));
      assert.equal(q.status, 503);
      assert.ok(q.headers.get("retry-after"));
      assert.equal((await introspect(w.accessToken)).active, false);
      assert.notEqual(await w.rsStatus(), 200);
      await assert.rejects(() => exchangeOAuthRefreshToken({ clientId: w.clientId, refreshToken: w.refreshToken }));

      // The app's view: the next due attempt gets 503s. It keeps using the data. It cannot tell this from an outage.
      await w.client.onReadFailure(w.grantId);
      await w.advance(t0 + 3 * DAY);
      const statuses = new Set(w.queries(t0 + 3 * HOUR).map((c) => c.status));
      const n503 = w.queries(t0 + 3 * HOUR).filter((c) => c.status === 503).length;
      note(4, "(a) app after 3 days", { statuses: [...statuses], http_503_attempts: n503, use_log: w.useLog.length });
      assert.deepEqual([...statuses], [503]);
      assert.ok(n503 >= 24 * 2, "hourly retries, each a failed attempt");
      assert.equal(w.useLog.every((u) => u.ok), true, "the AS failed closed; the app keeps using the data");
      assert.equal(w.client.canUse(w.grantId).ok, true);

      // The owner sees the restored statement, repeats the delete: recorded at once, returnable meanwhile.
      const again = await w.ownerErase();
      assert.equal(again.history_state, "restored_not_current");
      assert.equal(again.erasures.length, 1, "recorded and pending");
      assert.equal(again.erasures[0].stages.latest, "requested");
      await w.advance(w.clock.now + 2 * HOUR);
      const e = w.client.grantState(w.grantId)?.erasures.values().next().value;
      assert.ok(e, "the AS returned the recorded instruction from restored state, as 1488 allows");
      assert.equal(w.use(), false);
      note(4, "(a) after the owner repeats the delete", { received_day: days(e.receivedAt - t0), learned_late: e.learnedLate, owner_chose_day: 3 });
      // Facts are re-established outside the restored history; no second instruction appears.
      const before = (await w.ownerRecord()).erasures.length;
      // `getHeldDataRuntime()` is the reopened authority.
      getHeldDataRuntime()?.authority.reestablishGrants([{ grantId: w.grantId, ended: { path: "owner_withdrawal", disposition: "delete" }, erase: true }]);
      const after = await w.ownerRecord();
      assert.equal(after.history_state, "current");
      assert.equal(after.erasures.length, before, "re-establishment does not add a second instruction");
    });
  });

  it("(b) undeclared path (VM snapshot revert): nothing detects it; the deletion is lost and the grant revives; the statement names the path", async () => {
    await journey({ runtime: { restoreMechanism: "invalidate_on_restore" } }, async (w, h) => {
      const t0 = w.clock.now;
      w.firstSync();
      await w.client.reconcile();
      const { rt, snapshot, now } = snapshotJournal(w);
      await w.advance(t0 + 2 * HOUR);
      const durabilityBefore = (await w.ownerRecord()).durability as string;
      await w.ownerErase();
      assert.equal((await w.ownerRecord()).erasures.length, 1);
      assert.notEqual(await w.rsStatus(), 200, "revoked: reads refused");
      // The VM snapshot is reverted: the old journal is back and so are the main database rows. No procedure ran.
      copyFileSync(snapshot, rt.authority.journalPath);
      installHeldDataRuntime({ ...rt, authority: HeldDataAuthority.open({ journalPath: rt.authority.journalPath, now }) });
      restoreGrantRows(w.grantId);

      const rec = await w.ownerRecord();
      note(4, "(b) owner view after the revert", { history_state: rec.history_state, grant_state: rec.grant_state, erasures: rec.erasures.length });
      assert.equal(rec.history_state, "current", "not detected");
      assert.equal(rec.erasures.length, 0, "the recorded deletion is lost");
      assert.equal(await w.rsStatus(), 200, "a revoked grant reads again");
      const refreshed = await exchangeOAuthRefreshToken({ clientId: w.clientId, refreshToken: w.refreshToken });
      assert.ok(refreshed, "the revoked refresh token works again");
      const answer = await lifecycle(h, { grant_id: w.grantId, token: w.refreshToken });
      assert.equal(answer.body.grants[0]?.held_data, "permitted", "a positive assessment for a grant the owner deleted");
      // The durability statement names the path, before and after.
      for (const text of [durabilityBefore, rec.durability as string]) {
        assert.match(text, /A rollback this AS does not detect, such as a revert of a virtual-machine snapshot, can revive revoked grants and lose recorded deletions\./);
      }
      assert.match(String(rec.durability_detail.undetected.join(" ")), /virtual-machine snapshot/);
      // The client that had not yet received the instruction is told `permitted` and keeps using the data.
      await w.advance(t0 + 3 * HOUR);
      assert.equal(w.use(), true);
    });
  });

  it("(b') a client that already received the instruction stays erased after the revert", async () => {
    await journey({ runtime: { restoreMechanism: "invalidate_on_restore" } }, async (w, h) => {
      const t0 = w.clock.now;
      w.firstSync();
      await w.client.reconcile();
      const { rt, snapshot, now } = snapshotJournal(w);
      await w.advance(t0 + HOUR);
      await w.ownerErase();
      await w.advance(t0 + 25 * HOUR);
      assert.equal(w.use(), false, "the client received the instruction and stopped");
      copyFileSync(snapshot, rt.authority.journalPath);
      installHeldDataRuntime({ ...rt, authority: HeldDataAuthority.open({ journalPath: rt.authority.journalPath, now }) });
      restoreGrantRows(w.grantId);
      const answer = await lifecycle(h, { grant_id: w.grantId, token: w.refreshToken });
      assert.equal(answer.body.grants[0]?.held_data, "permitted");
      w.client.onTokenResponse({ grantIds: [w.grantId], sentAt: w.clock.now });
      await w.advance(w.clock.now + DAY);
      assert.equal(w.use(), false, "erasure is terminal at the client: a later positive answer or token response cannot cancel it (1312)");
    });
  });
});

/* ------------------------------------------------------------------------------------------------
 * JOURNEY 5: a public client's lifecycle credential is disabled; lifecycle recovery; erasure; reports.
 *
 * Spec lines: 1388 (AS MAY disable a token for lifecycle use; ends no grant, records no disposition),
 * 1389 (a client whose tokens are disabled MUST be able to recover without a new data grant and
 * without read access; a public client: lifecycle recovery), 1474-1478 (recovery: owner reviews,
 * lifecycle-only access token, no refresh token, introspection active:false, not a positive
 * assessment, may expire), 1346 (a public client SHOULD ask the owner to approve recovery at the
 * owner's next interaction, and report the times it recorded; a late report keeps the recorded event
 * time), 1352 (a deletion date only from a reported receipt), 1386 (writes need current
 * authentication).
 *
 * VERDICT: MATCH for the main path (5), SURPRISE for 5b.
 *   (5) With every token of the grant disabled, each attempt gets HTTP 401 invalid_token (a failed
 *       attempt): 25 hourly 401s in the second day while use continues. The owner's delete during that
 *       time cannot reach the app. After the owner approves recovery, the next hourly attempt gets the
 *       instruction (late), the client reports `received` with its own receipt time and `completed`,
 *       and the owner sees "completed" with the deletion date measured from the reported receipt. The
 *       recovery token reads no records and is inactive at introspection.
 *   (5b) A client that disposes at its deadline (day 30 after receipt) finds its recovery token
 *       expired (the prototype's default is 24 h; the text allows an expiry): the completion report is
 *       refused with `current_authentication_required`, the prototype never retries it, and the AS
 *       shows "receipt reported, deletion due by <past date>" with no completion. The owner sees an
 *       apparently overdue deletion. The text says the client SHOULD ask the owner again at the next
 *       interaction; the prototype has no way to resend a completion report: a BREAK of the
 *       prototype against the SHOULD in 1346 (not against a MUST).
 *   SPEC FINDING: 1346 and 1478 together make completion reporting by a public client depend on a
 *   second owner approval whenever the recovery token expires before the client finishes. Say whether
 *   an AS SHOULD give a recovery token a lifetime of at least the deletion bound (30 days), or whether
 *   the client reports completion only when it next has the owner's attention.
 * ---------------------------------------------------------------------------------------------- */
describe("J5: disabled lifecycle credential and lifecycle recovery", () => {
  const disableAll = (w: World) => {
    const a = getHeldDataRuntime()!.authority;
    a.disableCredential(w.refreshToken);
    a.disableCredential(w.accessToken);
  };

  it("(5) disabled, owner deletes meanwhile, recovery, erasure, receipt and completion reported, owner sees the date", async () => {
    await journey({}, async (w, h) => {
      const t0 = w.clock.now;
      w.firstSync();
      await w.advance(t0 + HOUR);
      disableAll(w);
      assert.equal((await lifecycle(h, { grant_id: w.grantId, token: w.refreshToken })).status, 401, "a disabled token is refused with invalid_token");
      assert.equal(w.use(), true, "disabling ends no grant and records no disposition");
      assert.equal((await w.ownerRecord()).erasures.length, 0);

      await w.advance(t0 + 2 * DAY);
      const failed = w.queries().filter((q) => q.status === 401);
      note(5, "attempts with the credential disabled", { count: failed.length, first_day: days((failed[0]?.at ?? 0) - t0), gaps_all_one_hour: gaps(failed).every((g) => g === HOUR) });
      assert.equal((failed[0] as Call).at, t0 + DAY, "the first attempt is due at 24 h");
      assert.ok(gaps(failed).every((g) => g === HOUR));
      assert.equal(w.use(), true);

      // The owner deletes; the app cannot learn it.
      await w.ownerErase();
      const chosen = w.clock.now;
      await w.advance(chosen + 3 * DAY); // the owner does not meet the app again for three days
      assert.equal(w.use(), true, "401 on every attempt: the app does not learn of the instruction");
      assert.equal((await w.ownerRecord()).erasures[0].stages.latest, "requested");

      // The app asks the owner at their next interaction; the owner approves lifecycle recovery.
      const token = await w.recover();
      const review = (await w.ownerRecord()).erasures[0];
      assert.equal(review.stages.latest, "requested", "recovery alone is not a positive assessment or a delivery");
      assert.equal((await introspect(token)).active, false, "introspection reports active:false");
      assert.notEqual(await (async () => (await fetch(`${h.rsUrl}/v1/streams/top_artists/records`, { headers: { Authorization: `Bearer ${token}` } })).status)(), 200, "no read access");
      const approvedAt = w.clock.now;
      await w.advance(approvedAt + 2 * HOUR);
      await w.settle();
      const e = w.client.grantState(w.grantId)?.erasures.values().next().value;
      assert.ok(e);
      note(5, "after recovery", {
        hours_from_approval_to_receipt: hours(e.receivedAt - approvedAt),
        days_between_owner_choice_and_receipt: days(e.receivedAt - chosen),
        learned_late: e.learnedLate,
        writes: w.writes().map((x) => ({ report: x.report, status: x.status, error: x.error })),
      });
      assert.equal(e.learnedLate, true, "received 3 days after the choice: after the 48 h stop-use bound, so stop at once");
      assert.deepEqual(w.writes().map((x) => x.report), ["received", "completed"]);
      assert.ok(w.writes().every((x) => x.status === 200 && !x.error));
      const er = (await w.ownerRecord()).erasures[0];
      assert.equal(er.stages.latest, "completed");
      assert.equal(Date.parse(er.receipt_at), e.receivedAt, "the AS records the client's own receipt time");
      assert.equal(Date.parse(er.delete_by) - Date.parse(er.receipt_at), 30 * DAY, "the date is measured from the reported receipt");
      note(5, "owner view", { stage: er.stages.latest, receipt_at: er.receipt_at, delete_by: er.delete_by, completion: er.completion });
    });
  });

  it("(5b) disposal at the deadline, recovery token expired: the completion report is refused, never retried, and the owner sees an overdue-looking deletion", async () => {
    await journey({ policy: { disposeAt: "deadline" } }, async (w) => {
      const t0 = w.clock.now;
      w.firstSync();
      await w.advance(t0 + HOUR);
      await w.ownerErase();
      await w.recover();
      await w.advance(t0 + 25 * HOUR);
      await w.settle();
      const e0 = w.client.grantState(w.grantId)?.erasures.values().next().value;
      assert.ok(e0?.receiptReported, "the receipt was reported within the token's lifetime");
      await w.advance(e0.deleteBy + 2 * HOUR);
      await w.settle();
      const e = w.client.grantState(w.grantId)?.erasures.values().next().value;
      assert.ok(e?.disposedAt, "the client deleted at its deadline");
      const completion = w.writes().filter((x) => x.report === "completed");
      note(5, "(5b) completion write", completion);
      assert.equal(completion.length, 1, "tried once");
      assert.equal(completion[0]?.error, "current_authentication_required");
      assert.equal(e.completionReported, false);
      await w.advance(w.clock.now + 5 * DAY);
      assert.equal(w.writes().filter((x) => x.report === "completed").length, 1, "never retried");
      const er = (await w.ownerRecord()).erasures[0];
      note(5, "(5b) owner view", { stage: er.stages.latest, delete_by: er.delete_by, now: w.iso(w.clock.now), completion: er.completion });
      assert.equal(er.stages.latest, "receipt_reported");
      assert.ok(Date.parse(er.delete_by) < w.clock.now, "the deadline is past and the AS shows no completion");
    });
  });
});

/* ------------------------------------------------------------------------------------------------
 * JOURNEY 6: a legal hold with an `event:` end.
 *
 * Spec lines: 1344 (legal retention: keep only that data, no other processing; record scope, basis
 * and end as a date, an event or condition, or unknown, never an invented date; report it unless law
 * prohibits), 1376-1378 (`retained_until` forms, `retention_basis`, `retention_scope`), 1415
 * (`retained` is an exception, not completion; when the obligation ends and the client deletes the
 * retained data, it reports `completed`), 1418 (each `retained` report is kept with the AS's receipt
 * time; a later one corrects and does not overwrite; the AS MUST NOT show retained as completed
 * deletion and MUST show the end in the form given), 1297 (held data still held: queries continue).
 *
 * VERDICT: MATCH on the main path; one SURPRISE for the client's cost.
 *   The client deletes everything else at receipt, keeps the invoices, reports `retained` with
 *   `event:close of the 2026 tax audit`, basis and scope; the AS shows the event text and "not reported
 *   as deleted", records no completion; a correction (a different event text) is kept as a second
 *   entry beside the first; when the event happens the client deletes the invoices and reports
 *   `completed`; the AS then shows completion and keeps both retained entries.
 *   SURPRISE (implementer): because the retained invoices are still held data, the client keeps asking
 *   the AS daily for as long as the hold lasts (here 120 days: 120 queries in all), and because it is a public
 *   client whose grant ended, every report (retained, correction, completed) needs a fresh owner
 *   approval of lifecycle recovery once the earlier recovery token expires (three approvals).
 * ---------------------------------------------------------------------------------------------- */
describe("J6: legal hold with an event end", () => {
  it("retains invoices until the audit closes, reports it, corrects it, then completes", async () => {
    const invoice = { id: "inv1", stream: "invoices" };
    await journey(
      {
        policy: { disposeAt: "promptly" },
        legalRetention: () => ({
          scope: "invoices for 2026",
          basis: "tax record-keeping law",
          end: { kind: "event", text: "close of the 2026 tax audit" },
          records: [invoice],
          requiredProcessing: ["tax-filing"],
        }),
      },
      async (w) => {
        const t0 = w.clock.now;
        w.firstSync([{ ...invoice, text: "invoice for 2026" }]);
        await w.advance(t0 + HOUR);
        await w.ownerErase();
        await w.recover(); // approval 1
        await w.advance(t0 + 25 * HOUR);
        await w.settle();
        const opId = [...(w.client.grantState(w.grantId)?.erasures.keys() ?? [])][0] as string;
        const e = w.client.grantState(w.grantId)?.erasures.get(opId);
        assert.ok(e);
        assert.deepEqual(w.app.holds(w.grantId).records, 1, "the rest is deleted, the invoice is kept");
        assert.equal(w.app.records.get(w.grantId)?.[0]?.id, "inv1");
        assert.equal(w.use(), false, "ordinary use of the covered data stays refused");
        assert.deepEqual(w.client.canProcessRetained(w.grantId, "tax-filing"), { ok: true });
        assert.deepEqual(w.client.canProcessRetained(w.grantId, "analytics"), { ok: false, reason: "not_required" });
        assert.deepEqual(w.writes().map((x) => x.report).sort(), ["received", "retained"]);
        let er = (await w.ownerRecord()).erasures[0];
        note(6, "AS after the retained report", { stage: er.stages.latest, retained: er.retained.map((r: any) => r.retained_until_display), completion: er.completion });
        assert.equal(er.stages.latest, "exception_reported");
        assert.equal(er.completion, null, "never completed while the event has not happened");
        assert.deepEqual(er.retained[0].retained_until, { form: "event", text: "close of the 2026 tax audit" });
        assert.equal(er.retained[0].retention_basis, "tax record-keeping law");
        assert.equal(er.retained[0].retention_scope, "invoices for 2026");
        assert.match(er.owner_message, /not reported as deleted/);
        assert.equal(Date.parse(er.delete_by) - e.receivedAt, 30 * DAY, "the date still comes from the reported receipt");

        // The hold lasts. The client still holds data of the grant, so it still asks daily.
        await w.advance(t0 + 60 * DAY);
        const daily = w.queries(t0 + 4 * HOUR, t0 + 60 * DAY);
        note(6, "daily queries during the hold", { count: daily.length });
        assert.ok(daily.every((q) => q.status === 200 && q.held === "erase"));
        assert.ok(gaps(daily).every((g) => g === DAY), "one query per reconciliation interval");

        // A correction: the audit is extended. The recovery token has expired, so the owner approves again.
        await w.recover(); // approval 2
        assert.equal(
          w.client.correctLegalRetention(w.grantId, opId, { end: { kind: "event", text: "close of the 2026 tax audit, extended by the authority" } }),
          true,
        );
        await w.settle();
        er = (await w.ownerRecord()).erasures[0];
        assert.equal(er.retained.length, 2, "the correction is kept beside the first report");
        assert.equal(er.retained[0].retained_until.text, "close of the 2026 tax audit", "not overwritten");
        assert.equal(er.retained[1].retained_until.text, "close of the 2026 tax audit, extended by the authority");
        assert.equal(er.completion, null);
        assert.equal(er.stages.latest, "exception_reported");

        // The audit closes on day 120: the client deletes the invoices and reports `completed`.
        await w.advance(t0 + 120 * DAY);
        await w.recover(); // approval 3
        assert.equal(w.client.endLegalRetention(w.grantId, opId), true);
        await w.settle();
        assert.deepEqual(w.app.holds(w.grantId), { records: 0, indexEntries: 0, summary: false });
        assert.deepEqual(w.writes().map((x) => `${x.report}:${x.status}${x.error ? `:${x.error}` : ""}`), [
          "received:200", "retained:200", "retained:200", "completed:200",
        ]);
        er = (await w.ownerRecord()).erasures[0];
        note(6, "AS after completion", { stage: er.stages.latest, retained_entries: er.retained.length, completion: er.completion, queries_total: w.queries().length });
        assert.equal(er.stages.latest, "completed");
        assert.ok(er.completion);
        assert.equal(er.retained.length, 2, "the retained reports stay on record");
        assert.equal(w.client.nextAttemptAt, null, "no held data left, so no further query");
      },
    );
  });
});

describe("J6b: the same hold when the client deletes at its deadline", () => {
  it("rest deleted on day 30 after receipt, invoices kept; the retained report needs a second owner approval, because the first token has expired", async () => {
    const invoice = { id: "inv1", stream: "invoices" };
    await journey(
      {
        policy: { disposeAt: "deadline" },
        legalRetention: () => ({
          scope: "invoices for 2026",
          basis: "tax record-keeping law",
          end: { kind: "event", text: "close of the 2026 tax audit" },
          records: [invoice],
        }),
      },
      async (w) => {
        const t0 = w.clock.now;
        w.firstSync([{ ...invoice, text: "invoice for 2026" }]);
        await w.advance(t0 + HOUR);
        await w.ownerErase();
        await w.recover(); // approval 1: the receipt report
        await w.advance(t0 + 25 * HOUR);
        await w.settle();
        const e = w.client.grantState(w.grantId)?.erasures.values().next().value;
        assert.ok(e);
        assert.equal(w.app.holds(w.grantId).records, 3, "nothing deleted yet: the app takes the whole 30 days");
        assert.equal(w.use(), false);
        await w.advance(e.deleteBy - HOUR);
        assert.equal(w.app.holds(w.grantId).records, 3, "an hour before the deadline");
        await w.recover(); // approval 2, the day before the deadline
        await w.advance(e.deleteBy + HOUR);
        await w.settle();
        assert.equal(w.app.holds(w.grantId).records, 1, "at the deadline the rest is gone and the invoice stays");
        const er = (await w.ownerRecord()).erasures[0];
        note(6, "(deadline policy) AS view", { stage: er.stages.latest, retained: er.retained.map((r: any) => r.retained_until_display), writes: w.writes().map((x) => `${x.report}:${x.status}`) });
        assert.equal(er.stages.latest, "exception_reported");
        assert.equal(er.completion, null);
      },
    );
  });
});
