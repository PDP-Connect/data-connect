// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Held-data lifecycle prototype: the AS authority and the client library.
 *
 * - The ending-path table of integration-v2 §2, at the authority.
 * - Status authentication (K3), unknown vs foreign grants, batching.
 * - Positive assessment, cadence and triggers (K3) at the client.
 * - Restore safety (K4): replica staleness and loss of the journal.
 * - The journeys of converge-r1-astra §4 items 1–3 and design-astra §7.
 *
 * The HTTP paths in the RI are in held-data-as-e2e.test.ts.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AuthorityUnavailableError,
  DispositionError,
  HeldDataAuthority,
  type StatusAnswer,
  type StatusResult,
} from "../lib/held-data/authority.ts";
import { DAY, HOUR, MIN, Sim, T0, tempDir } from "./helpers/held-data-sim.ts";

function authority(now: () => number) {
  const dir = tempDir("pdpp-held-auth-");
  const journalPath = join(dir, "authority.journal");
  const as = HeldDataAuthority.open({ journalPath, now, epochMarkerPath: join(dir, "epoch") });
  return { as, dir, journalPath };
}

function reg(as: HeldDataAuthority, grantId: string, o: { client?: string; confidential?: boolean; expiresAtMs?: number | null; trainingOnly?: boolean } = {}) {
  as.registerGrant({
    grantId,
    clientId: o.client ?? "app",
    subjectId: "owner",
    confidential: o.confidential ?? false,
    trainingOnly: o.trainingOnly ?? false,
    streams: ["messages", "contacts"],
    expiresAtMs: o.expiresAtMs ?? null,
  });
}

function ask(as: HeldDataAuthority, token: string, grantIds: string[], extra: { dpopJkt?: string; clientId?: string } = {}): StatusResult[] | null {
  const p = as.authenticateRead({ token, ...extra });
  return p ? as.status(p, grantIds) : null;
}

function answer(r: StatusResult[] | null): StatusAnswer {
  const a = r?.[0];
  assert.ok(a && !("error" in a), `expected an answer, got ${JSON.stringify(r)}`);
  return a;
}

describe("ending paths (integration-v2 §2) at the authority", () => {
  const t = T0;
  it("owner paths need a disposition; an API call without one is rejected, never defaulted", () => {
    const { as } = authority(() => t);
    reg(as, "g");
    for (const path of ["owner_withdrawal", "client_disconnect", "package_disconnect", "one_child_withdrawal", "narrowing", "decommission"] as const) {
      assert.throws(() => as.end({ grantId: "g", path }), DispositionError);
    }
    assert.equal(as.hasEnded("g"), false, "a rejected call records nothing");
  });

  it("owner withdrawal with keep: ended, ordinary use still permitted; with delete: erasure accepted, use stopped", () => {
    const { as } = authority(() => t);
    reg(as, "k");
    reg(as, "d");
    as.recordCredential({ token: "tk", grantIds: ["k"], kind: "access" });
    as.recordCredential({ token: "td", grantIds: ["d"], kind: "access" });
    assert.equal(as.end({ grantId: "k", path: "owner_withdrawal", disposition: "keep" }).erasure, null);
    const del = as.end({ grantId: "d", path: "owner_withdrawal", disposition: "delete" });
    assert.ok(del.erasure);
    const k = answer(ask(as, "tk", ["k"]));
    assert.equal(k.grant_state, "ended");
    assert.equal(k.ordinary_use, "permitted");
    assert.equal(k.ending?.disposition, "keep");
    const d = answer(ask(as, "td", ["d"]));
    assert.equal(d.ordinary_use, "stopped");
    assert.equal(d.erasures[0]?.operation_id, del.erasure.operationId);
  });

  it("client-initiated revocation: disposition optional; with delete, erasure binds; without, no erasure", () => {
    const { as } = authority(() => t);
    reg(as, "a");
    reg(as, "b");
    assert.equal(as.end({ grantId: "a", path: "client_revocation" }).erasure, null);
    assert.ok(as.end({ grantId: "b", path: "client_revocation", disposition: "delete" }).erasure);
  });

  it("security revocation: no disposition allowed, owner must be told, and a later owner election takes effect", () => {
    const { as } = authority(() => t);
    reg(as, "s");
    as.recordCredential({ token: "ts", grantIds: ["s"], kind: "access" });
    assert.throws(() => as.end({ grantId: "s", path: "security_revocation", disposition: "delete" }), DispositionError);
    as.end({ grantId: "s", path: "security_revocation" });
    const a = answer(ask(as, "ts", ["s"]));
    assert.equal(a.ending?.owner_notice_required, true);
    assert.equal(a.ordinary_use, "permitted", "no automatic erasure");
    assert.ok(as.elect({ grantId: "s", disposition: "delete" }));
    assert.equal(answer(ask(as, "ts", ["s"])).ordinary_use, "stopped");
  });

  it("narrowing carries a disposition; delete erases the whole old copy (Core), and the client reads again under the new grant", () => {
    const { as } = authority(() => t);
    reg(as, "old");
    as.recordCredential({ token: "to", grantIds: ["old"], kind: "access" });
    assert.throws(() => as.end({ grantId: "old", path: "narrowing" }), DispositionError);
    const r = as.end({ grantId: "old", path: "narrowing", disposition: "delete" });
    assert.ok(r.erasure);
    assert.deepEqual(answer(ask(as, "to", ["old"])).erasures[0]?.scope, { streams: "all" });
    assert.equal(answer(ask(as, "to", ["old"])).ordinary_use, "stopped");
  });

  it("expiry is not an ending: grant_state expired, ordinary use still permitted, no erasure", () => {
    let now = T0;
    const { as } = authority(() => now);
    reg(as, "e", { expiresAtMs: T0 + HOUR });
    as.recordCredential({ token: "te", grantIds: ["e"], kind: "access" });
    now = T0 + 2 * HOUR;
    const a = answer(ask(as, "te", ["e"]));
    assert.equal(a.grant_state, "expired");
    assert.equal(a.ordinary_use, "permitted");
    assert.equal(a.erasures.length, 0);
  });

  it("refresh replay is not an ending: nothing is recorded and status is unchanged", () => {
    // In the RI the replay path revokes the token family without calling revokeGrant
    // (checked over HTTP in held-data-as-e2e). Here: no ending, no erasure.
    const { as } = authority(() => t);
    reg(as, "r");
    as.recordCredential({ token: "rt1", grantIds: ["r"], kind: "refresh" });
    as.recordCredential({ token: "rt2", grantIds: ["r"], kind: "refresh" });
    assert.equal(answer(ask(as, "rt1", ["r"])).grant_state, "active", "the superseded refresh token still reads status");
    assert.equal(as.hasEnded("r"), false);
  });

  it("training-only grant kept: custody only, never ordinary use (A1 F4)", () => {
    const { as } = authority(() => t);
    reg(as, "tr", { trainingOnly: true });
    as.recordCredential({ token: "ttr", grantIds: ["tr"], kind: "access" });
    as.end({ grantId: "tr", path: "owner_withdrawal", disposition: "keep" });
    assert.equal(answer(ask(as, "ttr", ["tr"])).ordinary_use, "custody_only");
  });

  it("erasure is terminal: a later keep, a retry, or re-ending cannot cancel it; a repeat returns the same operation", () => {
    let now = T0;
    const { as } = authority(() => now);
    reg(as, "g");
    const first = as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" }).erasure;
    now += DAY;
    assert.equal(as.elect({ grantId: "g", disposition: "keep" }), null);
    const again = as.end({ grantId: "g", path: "package_disconnect", disposition: "delete" }).erasure;
    assert.equal(again?.operationId, first?.operationId);
    assert.equal(again?.acceptedAt, first?.acceptedAt, "a retry never restarts the clock");
  });

  it("a later erase after keep is a new operation with its own time (A1 F6), even through a repeated package disconnect", () => {
    let now = T0;
    const { as } = authority(() => now);
    reg(as, "g");
    as.recordCredential({ token: "t", grantIds: ["g"], kind: "access" });
    const kept = as.end({ grantId: "g", path: "package_disconnect", disposition: "keep" });
    now = T0 + 100 * DAY;
    const later = as.end({ grantId: "g", path: "package_disconnect", disposition: "delete" });
    assert.equal(later.endedAt, kept.endedAt, "ended_at stays day 0");
    assert.equal(later.erasure?.acceptedAt, T0 + 100 * DAY, "the erasure has its own time");
  });
});

describe("status authentication (K3)", () => {
  it("accepts active, expired, superseded and revoked-grant tokens; refuses a token disabled for compromise", () => {
    let now = T0;
    const { as } = authority(() => now);
    reg(as, "g", { expiresAtMs: T0 + HOUR });
    as.recordCredential({ token: "a1", grantIds: ["g"], kind: "access" });
    as.recordCredential({ token: "a2", grantIds: ["g"], kind: "access" });
    now += 2 * HOUR;
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "keep" });
    assert.ok(ask(as, "a1", ["g"]));
    as.disableCredential("a1");
    assert.equal(ask(as, "a1", ["g"]), null);
    assert.ok(ask(as, "a2", ["g"]), "other credentials of the grant survive");
  });

  it("a DPoP-bound credential needs a proof by its key", () => {
    const { as } = authority(() => T0);
    reg(as, "g");
    as.recordCredential({ token: "b", grantIds: ["g"], kind: "access", jkt: "JKT1" });
    assert.equal(ask(as, "b", ["g"]), null);
    assert.equal(ask(as, "b", ["g"], { dpopJkt: "OTHER" }), null);
    assert.ok(ask(as, "b", ["g"], { dpopJkt: "JKT1" }));
  });

  it("unknown and foreign grants get the same failure", () => {
    const { as } = authority(() => T0);
    reg(as, "mine");
    reg(as, "theirs", { client: "other" });
    as.recordCredential({ token: "m", grantIds: ["mine"], kind: "access" });
    const foreign = ask(as, "m", ["theirs"]);
    const unknown = ask(as, "m", ["nope"]);
    assert.deepEqual(foreign?.[0], { grant_id: "theirs", error: "invalid_grant" });
    assert.deepEqual(unknown?.[0], { grant_id: "nope", error: "invalid_grant" });
  });

  it("only client-authenticated callers batch; each grant is authorized on its own", () => {
    const { as } = authority(() => T0);
    reg(as, "c1", { client: "conf", confidential: true });
    reg(as, "c2", { client: "conf", confidential: true });
    reg(as, "x", { client: "other", confidential: true });
    as.recordCredential({ token: "ct", grantIds: ["c1"], kind: "access" });
    assert.deepEqual(ask(as, "ct", ["c1"]), [{ grant_id: "c1", error: "invalid_grant" }], "a confidential client's token alone is not enough");
    assert.ok(ask(as, "ct", ["c1"], { clientId: "conf" }));
    const p = as.authenticateRead({ clientId: "conf" });
    assert.ok(p);
    const r = as.status(p, ["c1", "c2", "x"]);
    assert.equal(r.filter((x) => !("error" in x)).length, 2);
    assert.deepEqual(r[2], { grant_id: "x", error: "invalid_grant" });
  });

  it("serving an erasure records delivery; receipt and completion need the client (writes)", () => {
    let now = T0;
    const { as } = authority(() => now);
    reg(as, "g");
    as.recordCredential({ token: "t", grantIds: ["g"], kind: "access" });
    const op = as.requestErasure({ grantId: "g", origin: "owner_withdrawal" });
    assert.equal(as.ownerView("g", 30 * DAY)?.erasures[0]?.delivered_at, null);
    now += HOUR;
    ask(as, "t", ["g"]);
    assert.equal(as.ownerView("g", 30 * DAY)?.erasures[0]?.delivered_at, now);
    assert.equal(as.ownerView("g", 30 * DAY)?.erasures[0]?.delete_by, null, "no date until the client confirms receipt");
    assert.equal(as.report({ clientId: "other", grantId: "g", operationId: op.operationId, kind: "receipt" }), false);
    now += HOUR;
    assert.equal(as.report({ clientId: "app", grantId: "g", operationId: op.operationId, kind: "receipt" }), true);
    assert.equal(as.ownerView("g", 30 * DAY)?.erasures[0]?.delete_by, now + 30 * DAY);
  });
});

describe("client: positive assessment, cadence and triggers (K3)", () => {
  it("record delivery is not an assessment: synced data is unusable until status answers", async () => {
    const sim = new Sim();
    sim.sync();
    assert.deepEqual(sim.client.canUse("g1"), { ok: false, reason: "no_assessment" });
    await sim.client.reconcile();
    assert.equal(sim.client.canUse("g1").ok, true);
  });

  it("first check is due 24 h after first acquisition; a reread or transform never moves the clocks", async () => {
    const sim = new Sim({ policy: { retentionCeilingMs: 10 * DAY } });
    sim.sync();
    await sim.client.reconcile();
    const first = sim.client.grantState("g1")?.firstAcquiredAt;
    sim.t += 5 * DAY;
    sim.sync();
    sim.app.reindex("g1");
    assert.equal(sim.client.grantState("g1")?.firstAcquiredAt, first);
    const gone = await sim.runUntilGone(T0 + 20 * DAY);
    assert.equal(gone, T0 + 10 * DAY, "retention ceiling counts from first acquisition");
    assert.equal(sim.client.grantState("g1")?.deleteReason, "retention_ceiling");
  });

  it("a read failure showing the grant inactive triggers status before further use", async () => {
    const sim = new Sim();
    sim.sync();
    await sim.client.reconcile();
    sim.t += 2 * HOUR;
    sim.as.end({ grantId: "g1", path: "owner_withdrawal", disposition: "delete" });
    sim.t += 10 * MIN;
    assert.equal(sim.client.canUse("g1").ok, true, "the client does not know yet");
    await sim.client.onReadFailure("g1");
    assert.deepEqual(sim.client.canUse("g1"), { ok: false, reason: "deleted" });
  });

  it("after a suspend, overdue disposal runs before anything else, then reconciliation gates use", async () => {
    const sim = new Sim({ policy: { longStopMs: 90 * DAY } });
    sim.sync();
    await sim.client.reconcile();
    sim.t += 100 * DAY; // suspended: no ticks
    sim.outages = [[sim.t, sim.t + DAY]];
    await sim.client.onResume();
    assert.equal(sim.client.grantState("g1")?.deleteReason, "long_stop");
    assert.deepEqual(sim.app.holds("g1"), { records: 0, indexEntries: 0, summary: false });

    const sim2 = new Sim();
    sim2.sync();
    await sim2.client.reconcile();
    sim2.t += 3 * DAY;
    sim2.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" });
    await sim2.client.onResume();
    assert.equal(sim2.client.canUse("g1").ok, false, "an erasure issued during the suspend is learned before any use");
  });

  it("an older answer (lower AS position) is ignored: it never moves the freshness origin", async () => {
    const sim = new Sim();
    sim.sync();
    const principal = sim.as.authenticateRead({ token: sim.tokens.get("g1") ?? "" });
    assert.ok(principal);
    const older = sim.as.status(principal, ["g1"]);
    sim.t += 2 * HOUR;
    sim.addGrant("other"); // moves the journal position
    await sim.client.reconcile();
    const origin = sim.client.grantState("g1")?.freshnessOrigin;
    assert.equal(origin, sim.t);
    // The older answer is replayed later (a cache or a stale path).
    sim.answerFrom = { ...sim.as, authenticateRead: () => principal, status: () => older } as unknown as HeldDataAuthority;
    sim.t += HOUR;
    await sim.client.reconcile();
    assert.equal(sim.client.grantState("g1")?.freshnessOrigin, origin, "origin unchanged");
    assert.ok(sim.client.events.some((e) => e.kind === "ignored_stale_answer"));
  });

  it("delete removes the toy app's derivatives (index, summary) as well as records", async () => {
    const sim = new Sim();
    sim.sync();
    await sim.client.reconcile();
    assert.deepEqual(sim.app.search("g1", "hello")?.length, 1);
    sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" });
    await sim.client.reconcile();
    assert.deepEqual(sim.app.holds("g1"), { records: 0, indexEntries: 0, summary: false });
    assert.equal(sim.app.search("g1", "hello"), null);
  });

  it("owner asks the client directly while the AS is down: the clock starts at that request (K9)", async () => {
    const sim = new Sim({ policy: { disposeAt: "deadline" } });
    sim.sync();
    await sim.client.reconcile();
    sim.outages = [[sim.t, sim.t + 365 * DAY]];
    sim.t += 2 * DAY;
    const q = sim.t;
    sim.client.ownerDelete("g1");
    assert.equal(sim.client.canUse("g1").ok, false);
    const gone = await sim.runUntilGone(q + 60 * DAY);
    assert.equal(gone, q + 30 * DAY);
  });
});

describe("restore safety (K4)", () => {
  it("a stale replica would answer positive after an acknowledged erasure; the head check refuses instead", () => {
    const now = T0;
    const { as, dir, journalPath } = authority(() => now);
    reg(as, "g");
    as.recordCredential({ token: "t", grantIds: ["g"], kind: "access" });
    const snapshot = join(dir, "replica.journal");
    copyFileSync(journalPath, snapshot);
    as.requestErasure({ grantId: "g", origin: "owner_withdrawal" });
    assert.equal(answer(ask(as, "t", ["g"])).ordinary_use, "stopped");

    const naive = HeldDataAuthority.open({ journalPath: snapshot, now: () => now, primaryHead: () => 0 });
    // primaryHead 0 disables the check (any view is "current"): the hazard.
    assert.equal(answer(ask(naive, "t", ["g"])).ordinary_use, "permitted", "negative control: a stale view gives a positive answer");

    const checked = HeldDataAuthority.open({ journalPath: snapshot, now: () => now, primaryHead: () => as.position });
    assert.throws(() => ask(checked, "t", ["g"]), AuthorityUnavailableError);
    const unreachable = HeldDataAuthority.open({ journalPath: snapshot, now: () => now, primaryHead: () => null });
    assert.throws(() => ask(unreachable, "t", ["g"]), AuthorityUnavailableError);
  });

  it("a replica may serve a negative answer from a stale view", () => {
    const now = T0;
    const { as, dir, journalPath } = authority(() => now);
    reg(as, "g");
    as.recordCredential({ token: "t", grantIds: ["g"], kind: "access" });
    as.requestErasure({ grantId: "g", origin: "owner_withdrawal" });
    const snapshot = join(dir, "replica.journal");
    copyFileSync(journalPath, snapshot);
    as.registerGrant({ grantId: "later", clientId: "app", subjectId: "owner", confidential: false, streams: [], expiresAtMs: null });
    const r = HeldDataAuthority.open({ journalPath: snapshot, now: () => now, primaryHead: () => as.position });
    assert.equal(answer(ask(r, "t", ["g"])).ordinary_use, "stopped");
  });

  it("single-disk loss: with the epoch marker restored from backup, the authority fails closed; the client pauses at the threshold and the long-stop disposes", async () => {
    for (const longStopMs of [90 * DAY, null]) {
      const sim = new Sim({ policy: { pauseThresholdMs: 7 * DAY, longStopMs } });
      sim.sync();
      await sim.client.reconcile();
      const s = sim.t;
      sim.t += HOUR;
      // The disk dies: the journal is gone. The epoch marker comes back with the backup.
      rmSync(sim.journalPath);
      const reopened = HeldDataAuthority.open({ journalPath: sim.journalPath, now: () => sim.t, epochMarkerPath: sim.epochPath });
      assert.equal(reopened.lost, true);
      assert.throws(() => reopened.authenticateRead({ token: sim.tokens.get("g1") ?? "" }), AuthorityUnavailableError);
      assert.throws(
        () => reopened.status({ clientId: "app", grantIds: new Set(["g1"]), clientAuthenticated: false }, ["g1"]),
        AuthorityUnavailableError
      );
      assert.throws(() => reopened.registerGrant({ grantId: "x", clientId: "app", subjectId: "o", confidential: false, streams: [], expiresAtMs: null }), AuthorityUnavailableError);
      sim.answerFrom = reopened;
      const { lastUsable } = await sim.runUntil(s + 10 * DAY);
      const gone = await sim.runUntilGone(s + 200 * DAY, 6 * HOUR);
      console.log(
        `[held-data-lifecycle] disk loss, long-stop ${longStopMs === null ? "off" : "90 d"}: usable until s+${(((lastUsable ?? s) - s) / HOUR).toFixed(2)} h; copy ${gone === null ? "kept (paused) to 200 d" : `gone at s+${((gone - s) / DAY).toFixed(2)} d`}`
      );
      assert.ok(lastUsable !== null && lastUsable <= s + 7 * DAY);
      assert.equal(gone === null, longStopMs === null);
    }
  });

  it("single-disk loss with no marker restored: a fresh history; every old grant is unknown, so clients get invalid_grant and pause", () => {
    const now = T0;
    const { as, journalPath, dir } = authority(() => now);
    reg(as, "g");
    as.recordCredential({ token: "t", grantIds: ["g"], kind: "access" });
    rmSync(journalPath);
    rmSync(join(dir, "epoch"));
    const fresh = HeldDataAuthority.open({ journalPath, now: () => now, epochMarkerPath: join(dir, "epoch") });
    assert.equal(fresh.lost, false);
    assert.equal(fresh.authenticateRead({ token: "t" }), null, "the client sees an authentication failure, indistinguishable from an attack");
  });
});

describe("review fixes", () => {
  it("a corrupt complete journal line fails closed instead of being skipped", () => {
    const now = T0;
    const { as, journalPath } = authority(() => now);
    reg(as, "g");
    as.recordCredential({ token: "t", grantIds: ["g"], kind: "access" });
    as.requestErasure({ grantId: "g", origin: "owner_withdrawal" });
    const lines = readFileSync(journalPath, "utf8").split("\n");
    const i = lines.findIndex((l) => l.includes('"t":"erase"'));
    lines[i] = "{not json";
    writeFileSync(journalPath, lines.join("\n"));
    const reopened = HeldDataAuthority.open({ journalPath, now: () => now });
    assert.equal(reopened.lost, true);
    assert.throws(() => reopened.authenticateRead({ token: "t" }), AuthorityUnavailableError);
  });

  it("a token disabled before the journal has seen it stays disabled once registered", () => {
    const { as } = authority(() => T0);
    reg(as, "g");
    as.disableCredential("stolen");
    as.recordCredential({ token: "stolen", grantIds: ["g"], kind: "access" });
    assert.equal(as.authenticateRead({ token: "stolen" }), null);
    assert.equal(as.isDisabled("stolen"), true);
  });

  it("requestErasure reports the recorded acceptance time", () => {
    let now = T0;
    const { as } = authority(() => {
      now += 1000;
      return now;
    });
    reg(as, "g");
    const r = as.requestErasure({ grantId: "g", origin: "x" });
    assert.equal(as.ownerView("g", DAY)?.erasures[0]?.accepted_at, r.acceptedAt);
  });

  it("keep after a security revocation is recorded and clears the owner notice", () => {
    const { as } = authority(() => T0);
    reg(as, "s");
    as.recordCredential({ token: "ts", grantIds: ["s"], kind: "access" });
    as.end({ grantId: "s", path: "security_revocation" });
    assert.equal(answer(ask(as, "ts", ["s"])).ending?.owner_notice_required, true);
    as.elect({ grantId: "s", disposition: "keep" });
    assert.equal(answer(ask(as, "ts", ["s"])).ending?.owner_notice_required, false);
  });

  it("a custody-only (training) grant with daily positive answers is not deleted at the long-stop, and is never usable", async () => {
    const sim = new Sim({ grants: [] });
    sim.addGrant("tr", false, { trainingOnly: true });
    sim.app.sync("tr", [{ id: "x", stream: "messages", text: "kept" }]);
    await sim.client.reconcile();
    const { lastUsable } = await sim.runUntil(T0 + 100 * DAY, 6 * HOUR, "tr");
    assert.equal(lastUsable, null);
    assert.equal(sim.client.grantState("tr")?.deletedAt, null, "custody continues");
  });

  it("the reconciliation interval runs between attempt starts, so slow answers do not stretch it", async () => {
    const sim = new Sim();
    sim.sync();
    sim.responseDelayMs = 30 * MIN;
    const start = sim.t;
    await sim.client.reconcile();
    assert.equal(sim.client.nextAttemptAt, start + DAY);
  });

  it("reading again after a long-stop deletion is a new acquisition that is tracked again", async () => {
    const sim = new Sim({ policy: { longStopMs: 90 * DAY } });
    sim.sync();
    await sim.client.reconcile();
    sim.t += 100 * DAY;
    sim.outages = [[sim.t, sim.t + HOUR]];
    await sim.client.onResume();
    assert.equal(sim.client.grantState("g1")?.deleteReason, "long_stop");
    sim.t += 2 * HOUR;
    sim.sync();
    assert.equal(sim.client.grantState("g1")?.deletedAt, null);
    assert.equal(sim.client.grantState("g1")?.firstAcquiredAt, sim.t);
    await sim.client.reconcile();
    assert.equal(sim.client.canUse("g1").ok, true);
  });
});

describe("journeys (converge-r1-astra §4, design-astra §7)", () => {
  it("an expired single-use public client learns of a later erase; no read is reopened", async () => {
    const sim = new Sim({ grants: [] });
    sim.addGrant("su", false, { expiresAtMs: T0 + HOUR });
    sim.app.sync("su", [{ id: "r", stream: "messages", text: "one shot" }]);
    await sim.client.reconcile();
    sim.t = T0 + 10 * DAY;
    const op = sim.as.end({ grantId: "su", path: "owner_withdrawal", disposition: "delete" });
    await sim.client.tick();
    await sim.client.reconcile();
    assert.equal(sim.client.canUse("su").ok, false);
    assert.deepEqual(sim.app.holds("su"), { records: 0, indexEntries: 0, summary: false });
    const view = sim.as.ownerView("su", 30 * DAY);
    assert.equal(view?.erasures[0]?.operation_id, op.erasure?.operationId);
    assert.ok(view?.erasures[0]?.receipt_at, "the expired public client could report receipt only because the sim treats its write as current");
  });

  it("a revoked-with-keep copy stays usable with fresh status for as long as daily checks succeed", async () => {
    const sim = new Sim({ policy: { pauseThresholdMs: 48 * HOUR } });
    sim.sync();
    await sim.client.reconcile();
    sim.as.end({ grantId: "g1", path: "owner_withdrawal", disposition: "keep" });
    const { lastUsable } = await sim.runUntil(T0 + 30 * DAY, HOUR);
    assert.equal(lastUsable, T0 + 30 * DAY);
  });

  it("a compromised status credential is replaced without restoring read access", () => {
    const { as } = authority(() => T0);
    reg(as, "g");
    as.recordCredential({ token: "bound", grantIds: ["g"], kind: "access", jkt: "K" });
    as.recordCredential({ token: "bearer", grantIds: ["g"], kind: "access" });
    as.disableCredential("bound");
    as.disableCredential("bearer");
    assert.equal(as.replaceStatusCredential({ grantId: "g" }), null, "no proof, no replacement");
    assert.equal(as.replaceStatusCredential({ grantId: "g", jkt: "WRONG" }), null);
    const viaKey = as.replaceStatusCredential({ grantId: "g", jkt: "K" });
    assert.ok(viaKey);
    assert.equal(ask(as, viaKey, ["g"]), null, "the replacement is still bound to the key");
    assert.ok(ask(as, viaKey, ["g"], { dpopJkt: "K" }));
    const code = as.ownerRecoveryCode("g");
    assert.equal(ask(as, code, ["g"]), null, "a recovery code is not a status reader");
    const viaOwner = as.replaceStatusCredential({ grantId: "g", recoveryCode: code });
    assert.ok(viaOwner && ask(as, viaOwner, ["g"]));
    assert.equal(as.replaceStatusCredential({ grantId: "g", recoveryCode: code }), null, "one use");
    // Read access: the status credential is not an access token; the RS check is in held-data-as-e2e.
  });

  it("a subprocessor receives the original absolute deadlines and gets no fresh period", async () => {
    const sim = new Sim({ policy: { disposeAt: "deadline", pauseThresholdMs: 48 * HOUR } });
    sim.sync();
    await sim.client.reconcile();
    const useUntil0 = sim.sub.latest("g1")?.useUntil;
    assert.equal(useUntil0, T0 + 48 * HOUR, "pause relayed as an absolute time");
    sim.t += 3 * HOUR;
    sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" });
    await sim.client.reconcile();
    const q = sim.t;
    const deadline = sim.sub.latest("g1")?.erasures[0]?.deleteBy;
    assert.equal(deadline, q + 30 * DAY);
    sim.t += 10 * DAY;
    await sim.client.reconcile();
    assert.equal(sim.sub.latest("g1")?.erasures[0]?.deleteBy, deadline, "redelivery relays the same deadline");
    assert.equal(sim.sub.canUse("g1"), false);
    sim.t = deadline - MIN;
    sim.sub.tick();
    assert.equal(sim.sub.held.has("g1"), true);
    sim.t = deadline;
    sim.sub.tick();
    assert.equal(sim.sub.held.has("g1"), false);
  });

  it("one package child withdrawn, later the whole package: first only that child, then every child including an ended one", () => {
    let now = T0;
    const { as } = authority(() => now);
    for (const g of ["c1", "c2", "c3"]) {
      reg(as, g);
      as.recordCredential({ token: `t${g}`, grantIds: [g], kind: "access" });
    }
    as.end({ grantId: "c1", path: "one_child_withdrawal", disposition: "delete" });
    assert.equal(answer(ask(as, "tc2", ["c2"])).grant_state, "active");
    now += DAY;
    for (const g of ["c1", "c2", "c3"]) {
      as.end({ grantId: g, path: "package_disconnect", disposition: "delete" });
    }
    for (const g of ["c1", "c2", "c3"]) {
      assert.equal(answer(ask(as, `t${g}`, [g])).ordinary_use, "stopped");
    }
  });
});
