// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client side of Core v0.1.0 held data: first use, attempt-only queries, stop-use bound records,
 * day-only retention durations, checkpoint compatibility and legal retention (cases C1, C1a, C2, C4,
 * C5a and C9 at the client).
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToyApp } from "../examples/held-data-toy-app/app.ts";
import { MemoryClientCheckpointStorage } from "../lib/held-data/checkpoint.ts";
import {
  formatRetentionEnd,
  HeldDataClient,
  type HeldStore,
  type LegalRetentionSpec,
  parseRetentionDays,
  parseRetentionEnd,
  type ReportTransport,
  type StatusTransport,
} from "../lib/held-data/client.ts";
import { httpReportTransport } from "../lib/held-data/http-transport.ts";
import { DAY, HOUR, MIN, T0 } from "./helpers/held-data-sim.ts";

const unavailable: StatusTransport = async () => ({ ok: false, reason: "unreachable" });

function permitted(now: () => number): StatusTransport {
  return async (ids) => ({
    ok: true,
    results: ids.map((grant_id) => ({
      as_position: 1, assessed_at: now(), ending: null, erasures: [], expires_at: null, grant_id,
      grant_state: "active" as const, ordinary_use: "permitted" as const,
    })),
  });
}

/** An AS that answers `erase` for every grant, with the given effective time. */
function erasing(now: () => number, effectiveAt: () => number, operationId = "ers1"): StatusTransport {
  return async (ids) => ({
    ok: true,
    results: ids.map((grant_id) => ({
      as_position: 2, assessed_at: now(), ending: null,
      erasures: [{ operation_id: operationId, scope: { streams: "all" as const }, accepted_at: effectiveAt(), effective_at: effectiveAt() }],
      expires_at: null, grant_id, grant_state: "ended" as const, ordinary_use: "stopped" as const,
    })),
  });
}

const records = [
  { id: "r1", stream: "messages", text: "hello world" },
  { id: "inv1", stream: "invoices", text: "invoice for 2026" },
];

describe("first use and attempt-only queries (Core: Positive assessment and reconciliation)", () => {
  it("first use needs a positive assessment; after it AS silence starts no deadline for 400 days", async () => {
    let t = T0;
    const app = new ToyApp();
    const c = new HeldDataClient({ now: () => t, status: unavailable, store: app });
    app.attach(c);
    app.sync("g", records);
    assert.deepEqual(c.canUse("g"), { ok: false, reason: "no_assessment" }, "record delivery is not an assessment");
    c.onTokenResponse({ grantIds: ["g"], sentAt: t });
    assert.equal(c.canUse("g").ok, true, "a token response that returns the grant is a positive assessment");
    for (let i = 0; i < 400; i += 1) {
      t += DAY;
      // biome-ignore lint/performance/noAwaitInLoops: the days are sequential.
      await c.tick();
      assert.equal(c.canUse("g").ok, true, `day ${i + 1}`);
    }
    assert.equal(app.holds("g").records, 2);
  });

  it("a token response that returns the grant counts as a query: it ends retries and restarts the interval", async () => {
    let t = T0;
    const app = new ToyApp();
    const c = new HeldDataClient({ now: () => t, status: unavailable, store: app });
    app.attach(c);
    app.sync("g", records);
    c.onTokenResponse({ grantIds: ["g"], sentAt: t });
    t += DAY;
    await c.tick(); // the due attempt fails
    assert.equal(c.nextAttemptAt, t + HOUR, "retry mode after a failed attempt");
    t += 10 * MIN;
    c.onTokenResponse({ grantIds: ["g"], sentAt: t });
    assert.equal(c.nextAttemptAt, t + DAY, "the token response ended retries and restarted the reconciliation interval");
  });

  it("failure-triggered query: an attempt must start before further use, and a failed attempt does not stop permitted use", async () => {
    let t = T0;
    const app = new ToyApp();
    let calls = 0;
    const c = new HeldDataClient({ now: () => t, status: async () => { calls += 1; return { ok: false, reason: "http_503" }; }, store: app });
    app.attach(c);
    app.sync("g", records);
    c.onTokenResponse({ grantIds: ["g"], sentAt: t });
    t += HOUR;
    // The read failed with 401 invalid_token. The duty is to START a query before further use.
    const pending = c.onReadFailure("g");
    assert.deepEqual(c.canUse("g"), { ok: true, until: null }, "once the attempt has started, use is not blocked");
    await pending;
    assert.equal(calls, 1);
    assert.equal(c.canUse("g").ok, true, "the attempt failed; the grant's terms still permit use");
  });

  it("resume after an attempt fell due starts a query before use; resume with nothing due does not", async () => {
    let t = T0;
    const app = new ToyApp();
    const storage = new MemoryClientCheckpointStorage();
    const first = new HeldDataClient({ now: () => t, status: permitted(() => t), store: app, storage, initialize: true });
    app.attach(first);
    app.sync("g", records);
    await first.reconcile();
    // Powered off for 3 h: nothing was due.
    t += 3 * HOUR;
    let calls = 0;
    const second = new HeldDataClient({ now: () => t, status: async () => { calls += 1; return { ok: false, reason: "unreachable" }; }, store: app, storage });
    app.attach(second);
    assert.equal(second.canUse("g").ok, true, "no attempt fell due while off, so no query is owed before use");
    // Powered off past the 24 h attempt.
    t += 2 * DAY;
    const third = new HeldDataClient({ now: () => t, status: async () => { calls += 1; return { ok: false, reason: "unreachable" }; }, store: app, storage });
    app.attach(third);
    assert.deepEqual(third.canUse("g"), { ok: false, reason: "reconcile_required" }, "an attempt fell due: start one first");
    await third.onResume();
    assert.equal(calls, 1);
    assert.equal(third.canUse("g").ok, true, "the attempt failed, and permitted use goes on");
  });

  it("suspension is counted: wall time that monotonic time omits marks a due attempt, and only a due one", async () => {
    let wall = T0;
    let mono = 0;
    const app = new ToyApp();
    const c = new HeldDataClient({ now: () => wall, monotonicMs: () => mono, status: permitted(() => wall), store: app });
    app.attach(c);
    app.sync("g", records);
    await c.reconcile();
    wall += 2 * HOUR; // suspend; nothing due
    assert.equal(c.canUse("g").ok, true);
    wall += 2 * DAY; // suspend across the 24 h attempt
    assert.deepEqual(c.canUse("g"), { ok: false, reason: "reconcile_required" });
  });
});

describe("stop-use bound and first receipt (Core: Erasure)", () => {
  it("records the effective time, the 48 h bound, and that use stopped at receipt", async () => {
    let t = T0;
    const app = new ToyApp();
    const effective = T0 + 2 * HOUR;
    const c = new HeldDataClient({ now: () => t, status: erasing(() => t, () => effective), store: app, policy: { disposeAt: "deadline" } });
    app.attach(c);
    app.sync("g", records);
    c.onTokenResponse({ grantIds: ["g"], sentAt: t });
    t = T0 + 5 * HOUR;
    await c.reconcile();
    const e = c.grantState("g")?.erasures.get("ers1");
    assert.ok(e);
    assert.equal(e.effectiveAt, effective);
    assert.equal(e.stopUseBy, effective + 48 * HOUR);
    assert.equal(e.receivedAt, t);
    assert.equal(e.stoppedUseAt, t);
    assert.equal(e.learnedLate, false);
    assert.equal(e.deleteBy, t + 30 * DAY, "the deletion bound runs from first receipt, not from the effective time");
    assert.deepEqual(c.canUse("g"), { ok: false, reason: "erased" });
  });

  it("an instruction learned after effective + 48 h is marked late and use ends at once", async () => {
    let t = T0;
    const app = new ToyApp();
    const effective = T0 + HOUR;
    const c = new HeldDataClient({ now: () => t, status: erasing(() => t, () => effective), store: app, policy: { disposeAt: "deadline" } });
    app.attach(c);
    app.sync("g", records);
    c.onTokenResponse({ grantIds: ["g"], sentAt: t });
    const job = app.enqueue("g", "hello");
    assert.equal(app.start(job), true);
    t = effective + 49 * HOUR;
    await c.reconcile();
    assert.equal(c.grantState("g")?.erasures.get("ers1")?.learnedLate, true);
    assert.equal(app.finish(job), null, "in-flight work is cancelled at receipt");
    assert.equal(c.canUse("g").ok, false);
  });

  it("the owner's delete choice in the client is effective at once and is the first receipt", () => {
    let t = T0;
    const app = new ToyApp();
    const c = new HeldDataClient({ now: () => t, status: unavailable, store: app, policy: { disposeAt: "deadline" } });
    app.attach(c);
    app.sync("g", records);
    c.onTokenResponse({ grantIds: ["g"], sentAt: t });
    t += 3 * DAY;
    const id = c.ownerDelete("g");
    const e = c.grantState("g")?.erasures.get(id);
    assert.ok(e);
    assert.equal(e.effectiveAt, t);
    assert.equal(e.receivedAt, t);
    assert.equal(e.stopUseBy, t + 48 * HOUR);
    assert.equal(e.deleteBy, t + 30 * DAY);
    assert.equal(c.canUse("g").ok, false);
  });

  it("deletion is by the earlier of receipt + 30 d and each record's retention ceiling", async () => {
    let t = T0;
    const app = new ToyApp();
    const c = new HeldDataClient({
      now: () => t, status: unavailable, store: app, policy: { disposeAt: "deadline", retentionCeilingMs: 10 * DAY },
    });
    app.attach(c);
    app.sync("g", [records[0]!]);
    c.onTokenResponse({ grantIds: ["g"], sentAt: t });
    t = T0 + 8 * DAY;
    c.ownerDelete("g"); // receipt + 30 d would be day 38; the ceiling is day 10
    assert.equal(c.deleteBy("g"), T0 + 10 * DAY);
    t = T0 + 10 * DAY;
    void c.canUse("g");
    assert.equal(app.holds("g").records, 0);
  });
});

describe("clock discontinuity and restored state (Core C5a)", () => {
  it("a clock moved back never extends a deadline and disposes what it cannot show to be ahead", async () => {
    let t = T0;
    const app = new ToyApp();
    const c = new HeldDataClient({
      now: () => t, status: permitted(() => t), store: app, policy: { retentionCeilingMs: 10 * DAY },
    });
    app.attach(c);
    app.sync("g", [records[0]!]);
    await c.reconcile();
    t -= 3 * DAY;
    assert.equal(c.canUse("g").ok, false);
    assert.equal(app.holds("g").records, 0, "a ceiling that cannot be shown to lie ahead is due");
  });

  it("a restored checkpoint cannot extend a ceiling: the acquisition time is kept and overdue disposal runs before use", async () => {
    let t = T0;
    const app = new ToyApp();
    const storage = new MemoryClientCheckpointStorage();
    const policy = { retentionCeilingMs: 10 * DAY };
    const c = new HeldDataClient({ now: () => t, status: permitted(() => t), store: app, storage, initialize: true, policy });
    app.attach(c);
    app.sync("g", [records[0]!]);
    await c.reconcile();
    t = T0 + 12 * DAY; // powered off past the ceiling
    const restarted = new HeldDataClient({ now: () => t, status: unavailable, store: app, storage });
    app.attach(restarted);
    assert.equal(restarted.canUse("g").ok, false);
    assert.equal(app.holds("g").records, 0);
  });
});

describe("retention max_duration is day-only PnD", () => {
  it("accepts P<n>D with n a positive whole number and counts a day as 24 h", () => {
    assert.equal(parseRetentionDays("P1D"), DAY);
    assert.equal(parseRetentionDays("P90D"), 90 * DAY);
    assert.equal(parseRetentionDays("P180D"), 180 * DAY);
  });

  it("rejects months, years, weeks, time parts, zero, signs and fractions", () => {
    for (const bad of ["P0D", "P1M", "P1Y", "P1W", "PT24H", "P1DT1H", "P1.5D", "P-1D", "-P1D", "p1d", "P1D ", "", "90", null, undefined, 90]) {
      assert.equal(parseRetentionDays(bad), null, String(bad));
    }
  });

  it("a duration the client cannot count makes the ceiling already reached: it keeps nothing", () => {
    for (const bad of ["P1M", "PT24H", "P1Y"]) {
      const t = T0;
      const app = new ToyApp();
      const c = new HeldDataClient({ now: () => t, status: unavailable, store: app, retentionMaxDuration: bad });
      app.attach(c);
      assert.equal(c.acquire("legacy"), false, bad);
      assert.deepEqual(c.acquireRecords("g", records), [], bad);
      app.sync("g", records);
      assert.equal(app.holds("g").records, 0, bad);
    }
  });

  it("a conforming duration sets the ceiling from first acquisition", async () => {
    let t = T0;
    const app = new ToyApp();
    const c = new HeldDataClient({ now: () => t, status: permitted(() => t), store: app, retentionMaxDuration: "P2D" });
    app.attach(c);
    app.sync("g", [records[0]!]);
    await c.reconcile();
    t = T0 + 2 * DAY - 1;
    assert.equal(c.canUse("g").ok, true);
    t = T0 + 2 * DAY;
    assert.equal(c.canUse("g").ok, false);
    assert.equal(app.holds("g").records, 0);
  });
});

describe("checkpoint compatibility", () => {
  it("a version 1 checkpoint (pause, long-stop, freshness origin, one schedule) is read; the removed limits do nothing", async () => {
    let t = T0;
    const app = new ToyApp();
    const storage = new MemoryClientCheckpointStorage();
    const c = new HeldDataClient({ now: () => t, status: permitted(() => t), store: app, storage, initialize: true });
    app.attach(c);
    app.sync("g", [records[0]!]);
    await c.reconcile();
    const cp = JSON.parse(storage.read() ?? "{}");
    // Rewrite it the way a version 1 client wrote it.
    cp.version = 1;
    cp.policy.pauseThresholdMs = 7 * DAY;
    cp.policy.longStopMs = 90 * DAY;
    cp.policy.freshnessOrigin = "request_sent";
    cp.nextAttemptAt = t + DAY;
    for (const g of cp.grants) {
      g.freshnessOrigin = g.positiveAt;
      delete g.positiveAt;
      delete g.nextAttemptAt;
      delete g.lastAttemptStartAt;
    }
    storage.write(JSON.stringify(cp));
    t += 120 * DAY; // past the old long-stop
    const restarted = new HeldDataClient({ now: () => t, status: unavailable, store: app, storage });
    app.attach(restarted);
    assert.equal(restarted.grantState("g")?.positiveAt, T0, "freshnessOrigin reads as the positive assessment");
    assert.equal(restarted.nextAttemptAt, T0 + DAY, "the single schedule seeds the held grant");
    await restarted.onResume();
    assert.equal(restarted.canUse("g").ok, true, "the old long-stop no longer disposes the copy");
    assert.equal(app.holds("g").records, 1);
    const written = JSON.parse(storage.read() ?? "{}");
    assert.equal(written.version, 2);
    assert.equal("pauseThresholdMs" in written.policy, false);
    assert.equal("longStopMs" in written.policy, false);
  });

  it("an unreadable or unsupported checkpoint still fails closed", () => {
    const app = new ToyApp();
    app.records.set("g", [{ id: "r", stream: "s", text: "x" }]);
    app.reindex("g");
    const storage = new MemoryClientCheckpointStorage();
    storage.write(JSON.stringify({ version: 3 }));
    const c = new HeldDataClient({ now: () => T0, status: unavailable, store: app, storage });
    app.attach(c);
    assert.equal(c.canUse("g").ok, false);
    assert.equal(app.holds("g").records, 0);
  });
});

describe("legal retention (Core: Erasure, Legal retention; case C9 at the client)", () => {
  const invoices: LegalRetentionSpec = {
    scope: "invoices for 2026",
    basis: "tax record-keeping law",
    end: { kind: "event", text: "close of the 2026 tax audit" },
    records: [{ id: "inv1", stream: "invoices" }],
    requiredProcessing: ["tax-audit-disclosure"],
  };

  function harness(
    spec: LegalRetentionSpec | null | (() => LegalRetentionSpec | null),
    o: { storage?: MemoryClientCheckpointStorage; store?: HeldStore; policy?: object } = {}
  ) {
    const clock = { t: T0 };
    const app = new ToyApp();
    const reports: Parameters<ReportTransport>[0][] = [];
    const make = (initialize: boolean) => {
      const c = new HeldDataClient({
        now: () => clock.t,
        status: erasing(() => clock.t, () => clock.t),
        store: o.store ?? app,
        storage: o.storage ?? new MemoryClientCheckpointStorage(),
        initialize,
        legalRetention: () => (typeof spec === "function" ? spec() : spec),
        report: async (r) => { reports.push(r); return true; },
        ...(o.policy ? { policy: o.policy } : {}),
      });
      app.attach(c);
      return c;
    };
    const c = make(true);
    app.sync("g", records);
    c.onTokenResponse({ grantIds: ["g"], sentAt: clock.t });
    return { clock, app, c, reports, make };
  }

  it("deletes the other covered data by the deadline, keeps the invoices, reports retained and not completed", async () => {
    const { clock, app, c, reports } = harness(invoices);
    clock.t += HOUR;
    await c.reconcile();
    assert.deepEqual(app.records.get("g")?.map((r) => r.id), ["inv1"], "only the retained record remains");
    assert.deepEqual(app.holds("g").summary, true, "derivatives are regenerated without the deleted record");
    assert.equal(c.canUse("g").ok, false, "ordinary use stays refused");
    await new Promise((r) => setImmediate(r));
    const retained = reports.filter((r) => r.kind === "retained");
    assert.equal(retained.length, 1);
    assert.deepEqual(retained[0]?.retainedUntil, { kind: "event", text: "close of the 2026 tax audit" });
    assert.equal(retained[0]?.retentionBasis, "tax record-keeping law");
    assert.equal(retained[0]?.retentionScope, "invoices for 2026");
    assert.equal(retained[0]?.reportedAt, c.grantState("g")?.erasures.get("ers1")?.disposedAt);
    assert.equal(reports.some((r) => r.kind === "completion"), false, "retained data is an exception, not completion");
    assert.equal(c.grantState("g")?.erasures.get("ers1")?.completionReported, false);
  });

  it("processes the retained data only as the obligation requires, and only while it lasts", async () => {
    const { clock, c } = harness(invoices);
    clock.t += HOUR;
    await c.reconcile();
    assert.deepEqual(c.canProcessRetained("g", "tax-audit-disclosure"), { ok: true });
    assert.deepEqual(c.canProcessRetained("g", "marketing"), { ok: false, reason: "not_required" });
    assert.deepEqual(c.canProcessRetained("other", "tax-audit-disclosure"), { ok: false, reason: "no_retention" });
  });

  it("a restored data backup replays deletion of everything but the retained records", async () => {
    const { clock, app, c } = harness(invoices);
    clock.t += HOUR;
    await c.reconcile();
    // An older data backup brings both records back.
    app.records.set("g", structuredClone(records));
    app.reindex("g");
    assert.equal(c.canUse("g").ok, false);
    assert.deepEqual(app.records.get("g")?.map((r) => r.id), ["inv1"]);
  });

  it("the obligation ends on a date: the next tick deletes the retained data and reports completed", async () => {
    const end = { kind: "date" as const, at: T0 + 10 * DAY };
    const { clock, app, c, reports } = harness({ ...invoices, end });
    clock.t += HOUR;
    await c.reconcile();
    clock.t = T0 + 10 * DAY - 1;
    await c.tick();
    assert.equal(app.holds("g").records, 1, "still within the obligation");
    clock.t = T0 + 10 * DAY;
    await c.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(app.holds("g").records, 0);
    assert.equal(app.holds("g").summary, false);
    const done = reports.filter((r) => r.kind === "completion");
    assert.equal(done.length, 1);
    assert.equal(done[0]?.reportedAt, T0 + 10 * DAY, "completion is stamped when the retained data was deleted");
    assert.equal(c.canProcessRetained("g", "tax-audit-disclosure").ok, false);
  });

  it("an event or unknown end waits for the client to say the obligation ended, however long that takes", async () => {
    for (const end of [{ kind: "event" as const, text: "audit closes" }, { kind: "unknown" as const }]) {
      const { clock, app, c, reports } = harness({ ...invoices, end });
      clock.t += HOUR;
      await c.reconcile();
      clock.t += 1000 * DAY;
      await c.tick();
      assert.equal(app.holds("g").records, 1, JSON.stringify(end));
      assert.equal(c.endLegalRetention("g", "ers1"), true);
      await new Promise((r) => setImmediate(r));
      assert.equal(app.holds("g").records, 0);
      assert.equal(reports.filter((r) => r.kind === "completion").length, 1);
      assert.equal(c.endLegalRetention("g", "ers1"), false, "ending twice changes nothing");
    }
  });

  it("a correction re-reports with the new terms and keeps the records", async () => {
    const { clock, app, c, reports } = harness(invoices);
    clock.t += HOUR;
    await c.reconcile();
    const end = { kind: "date" as const, at: T0 + 400 * DAY };
    assert.equal(c.correctLegalRetention("g", "ers1", { end, basis: "tax law, section 7" }), true);
    await new Promise((r) => setImmediate(r));
    const retained = reports.filter((r) => r.kind === "retained");
    assert.equal(retained.length, 2);
    assert.deepEqual(retained[1]?.retainedUntil, end);
    assert.equal(retained[1]?.retentionBasis, "tax law, section 7");
    assert.equal(app.holds("g").records, 1);
    // An end the client cannot back with a real date is not accepted.
    assert.equal(c.correctLegalRetention("g", "ers1", { end: { kind: "date", at: T0 } }), false);
    assert.equal(c.correctLegalRetention("g", "ers1", { end: { kind: "event", text: "  " } }), false);
  });

  it("law may prohibit the report or only its basis and scope", async () => {
    const quiet = harness({ ...invoices, lawProhibits: { report: true } });
    quiet.clock.t += HOUR;
    await quiet.c.reconcile();
    await new Promise((r) => setImmediate(r));
    assert.equal(quiet.reports.some((r) => r.kind === "retained"), false);
    assert.equal(quiet.app.holds("g").records, 1, "the data is still kept");

    const partial = harness({ ...invoices, lawProhibits: { basis: true, scope: true } });
    partial.clock.t += HOUR;
    await partial.c.reconcile();
    await new Promise((r) => setImmediate(r));
    const sent = partial.reports.find((r) => r.kind === "retained");
    assert.ok(sent);
    assert.equal("retentionBasis" in sent, false);
    assert.equal("retentionScope" in sent, false);
    assert.deepEqual(sent.retainedUntil, invoices.end);
  });

  it("a failed report can be sent again once the client has current authentication", async () => {
    const clock = { t: T0 };
    const app = new ToyApp();
    let accept = false;
    const c = new HeldDataClient({
      now: () => clock.t, status: erasing(() => clock.t, () => clock.t), store: app, legalRetention: () => invoices,
      report: async (r) => r.kind !== "retained" || accept,
    });
    app.attach(c);
    app.sync("g", records);
    c.onTokenResponse({ grantIds: ["g"], sentAt: clock.t });
    clock.t += HOUR;
    await c.reconcile();
    await new Promise((r) => setImmediate(r));
    assert.equal(c.legalRetentionOf("g", "ers1")?.reported, false);
    accept = true;
    assert.equal(await c.reportRetention("g", "ers1"), true);
    assert.equal(c.legalRetentionOf("g", "ers1")?.reported, true);
  });

  it("declarations that name nothing real, or no end, keep nothing", async () => {
    const bad: LegalRetentionSpec[] = [
      { ...invoices, records: [] },
      { ...invoices, records: [{ id: "missing", stream: "invoices" }] },
      { ...invoices, basis: " " },
      { ...invoices, scope: "" },
      { ...invoices, end: { kind: "event", text: "" } },
      { ...invoices, end: { kind: "date", at: T0 - DAY } },
      { ...invoices, end: { kind: "date", at: Number.NaN } },
    ];
    for (const spec of bad) {
      const { clock, app, c } = harness(spec);
      clock.t += HOUR;
      // biome-ignore lint/performance/noAwaitInLoops: one harness per declaration.
      await c.reconcile();
      assert.equal(app.holds("g").records, 0, JSON.stringify(spec.end));
    }
  });

  it("a store that cannot delete all but the named records cannot honour the exception: everything is deleted", async () => {
    class Bare implements HeldStore {
      rows = new Set<string>();
      grantIds() { return this.rows; }
      dispose() { this.rows.clear(); }
    }
    const store = new Bare();
    const clock = { t: T0 };
    const c = new HeldDataClient({
      now: () => clock.t, status: erasing(() => clock.t, () => clock.t), store, legalRetention: () => invoices,
    });
    c.onTokenResponse({ grantIds: ["g"], sentAt: clock.t });
    assert.equal(c.acquire("g"), true);
    store.rows.add("g");
    clock.t += HOUR;
    await c.reconcile();
    assert.equal(store.rows.size, 0);
    assert.equal(c.legalRetentionOf("g", "ers1"), null);
  });

  it("declared before the deadline in deadline mode; refused after deletion", async () => {
    const { clock, app, c } = harness(null, { policy: { disposeAt: "deadline" } });
    clock.t += HOUR;
    await c.reconcile();
    assert.equal(app.holds("g").records, 2, "deadline mode: not deleted yet");
    assert.equal(c.declareLegalRetention("g", "ers1", invoices), true);
    clock.t += 30 * DAY;
    await c.tick();
    assert.deepEqual(app.records.get("g")?.map((r) => r.id), ["inv1"]);
    assert.equal(c.declareLegalRetention("g", "ers1", invoices), false, "too late: the covered data is already deleted");
  });

  it("retained terms survive a restart, and a restart does not delete the retained records", async () => {
    const storage = new MemoryClientCheckpointStorage();
    const { clock, app, c, make } = harness(invoices, { storage });
    clock.t += HOUR;
    await c.reconcile();
    const restarted = make(false);
    assert.deepEqual(restarted.legalRetentionOf("g", "ers1")?.end, invoices.end);
    assert.deepEqual(restarted.canProcessRetained("g", "tax-audit-disclosure"), { ok: true });
    assert.deepEqual(app.records.get("g")?.map((r) => r.id), ["inv1"]);
  });

  it("an untrusted clock deletes the other data but keeps what the law requires", async () => {
    const { clock, app, c } = harness(invoices);
    clock.t += HOUR;
    await c.reconcile();
    app.records.set("g", structuredClone(records)); // a restored backup brings the deleted record back
    app.reindex("g");
    clock.t -= 3 * DAY; // the clock moves back: no deadline can be shown to lie ahead
    assert.equal(c.canUse("g").ok, false);
    assert.deepEqual(app.records.get("g")?.map((r) => r.id), ["inv1"], "legal retention is the one exception");
    assert.equal(c.canProcessRetained("g", "tax-audit-disclosure").ok, false, "but no processing while the clock is untrusted");
  });

  it("reconciliation goes on while legally retained data is held, and stops when it is deleted", async () => {
    const { clock, c } = harness({ ...invoices, end: { kind: "unknown" } });
    clock.t += HOUR;
    await c.reconcile();
    assert.notEqual(c.nextAttemptAt, null, "retained data is still held data of the grant");
    c.endLegalRetention("g", "ers1");
    assert.equal(c.nextAttemptAt, null);
  });
});

describe("retained_until wire forms", () => {
  it("round-trips the three forms and rejects everything else", () => {
    const at = Date.UTC(2026, 10, 20, 9, 0, 0);
    assert.deepEqual(parseRetentionEnd("2026-11-20T09:00:00Z"), { kind: "date", at });
    assert.deepEqual(parseRetentionEnd("2026-11-20T10:00:00+01:00"), { kind: "date", at });
    assert.deepEqual(parseRetentionEnd("event:close of the 2026 tax audit"), { kind: "event", text: "close of the 2026 tax audit" });
    assert.deepEqual(parseRetentionEnd("unknown"), { kind: "unknown" });
    for (const bad of ["event:", "event:   ", "Unknown", "2026-11-20", "2026-11-20 09:00:00Z", "tomorrow", "", 5, null]) {
      assert.equal(parseRetentionEnd(bad), null, String(bad));
    }
    for (const end of [{ kind: "date" as const, at }, { kind: "event" as const, text: "x y" }, { kind: "unknown" as const }]) {
      assert.deepEqual(parseRetentionEnd(formatRetentionEnd(end)), end);
    }
  });

  it("the HTTP report transport sends report=retained with retained_until, basis and scope", async () => {
    const bodies: URLSearchParams[] = [];
    const transport = httpReportTransport({
      asBaseUrl: "https://as.example",
      currentTokenFor: () => "tok",
      now: () => T0,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(new URLSearchParams(String(init.body)));
        return new Response(JSON.stringify({ grants: [{ grant_id: "g" }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    assert.equal(await transport({
      grantId: "g", operationId: "ers1", kind: "retained", reportedAt: T0,
      retainedUntil: { kind: "event", text: "close of the 2026 tax audit" },
      retentionBasis: "tax record-keeping law", retentionScope: "invoices for 2026",
    }), true);
    const b = bodies[0];
    assert.equal(b?.get("report"), "retained");
    assert.equal(b?.get("instruction_id"), "ers1");
    assert.equal(b?.get("retained_until"), "event:close of the 2026 tax audit");
    assert.equal(b?.get("retention_basis"), "tax record-keeping law");
    assert.equal(b?.get("retention_scope"), "invoices for 2026");
    assert.equal(b?.get("reported_at"), new Date(T0).toISOString());

    await transport({ grantId: "g", operationId: "ers1", kind: "retained", reportedAt: T0, retainedUntil: { kind: "unknown" } });
    assert.equal(bodies[1]?.get("retained_until"), "unknown");
    assert.equal(bodies[1]?.has("retention_basis"), false);
    await transport({ grantId: "g", operationId: "ers1", kind: "retained", reportedAt: T0, retainedUntil: { kind: "date", at: T0 + DAY } });
    assert.equal(bodies[2]?.get("retained_until"), new Date(T0 + DAY).toISOString());
    await transport({ grantId: "g", operationId: "ers1", kind: "completion", reportedAt: T0 });
    assert.equal(bodies[3]?.get("report"), "completed");
    assert.equal(bodies[3]?.has("retained_until"), false);
  });
});
