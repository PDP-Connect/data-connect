// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Held-data lifecycle prototype: regression tests for the red-team review
 * (`redteam-sol.md`, probes RT1–RT15). Each test reproduces a probe's setup
 * and asserts the behaviour the Core draft requires. Before the fixes, each
 * one failed with the probe's observed defect. The HTTP-level probes (RT8,
 * RT12, RT13) are in held-data-as-e2e.test.ts.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToyApp, ToySubprocessor } from "../examples/held-data-toy-app/app.ts";
import { appendJournalEntry } from "../lib/authority-journal/journal.ts";
import { AuthorityUnavailableError, HeldDataAuthority, type StatusResult } from "../lib/held-data/authority.ts";
import { HeldDataClient, type StatusTransport } from "../lib/held-data/client.ts";
import { TrainingAuthorityStore } from "../lib/training-lease/authority-store.ts";
import { type Jwks, validateLeaseStatic } from "../lib/training-lease/worker.ts";
import { DAY, HOUR, MIN, Sim, T0, tempDir } from "./helpers/held-data-sim.ts";

function authority(now: () => number) {
  const dir = tempDir("pdpp-held-rt-");
  const journalPath = join(dir, "authority.journal");
  const epochMarkerPath = join(dir, "epoch");
  return { as: HeldDataAuthority.open({ journalPath, now, epochMarkerPath }), dir, journalPath, epochMarkerPath };
}

function reg(as: HeldDataAuthority, grantId: string, trainingOnly = false) {
  as.registerGrant({
    grantId,
    clientId: "app",
    subjectId: "owner",
    confidential: false,
    trainingOnly,
    streams: ["messages"],
    expiresAtMs: null,
  });
}

describe("red-team findings (redteam-sol.md)", () => {
  it("RT3 (finding 3): a late delivery after an owner delete stays disposed; an old positive answer cannot revive the copy", async () => {
    let t = T0;
    const as = authority(() => t).as;
    reg(as, "g");
    as.recordCredential({ token: "tok", grantIds: ["g"], kind: "access" });
    const answer = (): StatusResult[] => {
      const p = as.authenticateRead({ token: "tok" });
      return p ? as.status(p, ["g"]) : [];
    };
    let release: (() => void) | null = null;
    let blocked = false;
    const status: StatusTransport = async () => {
      const results = answer();
      if (blocked) {
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return { ok: true, results };
    };
    const app = new ToyApp();
    const client = new HeldDataClient({ now: () => t, status, store: app });
    app.attach(client);
    app.sync("g", [{ id: "r1", stream: "messages", text: "covered record" }]);
    await client.reconcile();
    assert.equal(client.canUse("g").ok, true);
    blocked = true;
    const inFlight = client.reconcile();
    client.ownerDelete("g");
    t += 2000;
    app.sync("g", [{ id: "r2", stream: "messages", text: "late covered record" }]);
    (release as (() => void) | null)?.();
    await inFlight;
    assert.equal(client.canUse("g").ok, false);
    assert.equal(app.search("g", "covered"), null);
    assert.deepEqual(app.holds("g"), { records: 0, indexEntries: 0, summary: false });
    assert.ok((client.grantState("g")?.erasures.size ?? 0) > 0, "the erasure facts survive");
  });

  it("RT15 (finding 3): overdue long-stop disposal runs before a new assessment on every entry path (onReadFailure, reconcile)", async () => {
    for (const entry of ["onReadFailure", "reconcile"] as const) {
      const sim = new Sim({ policy: { longStopMs: 90 * DAY } });
      sim.sync();
      await sim.client.reconcile();
      sim.t = T0 + 100 * DAY;
      if (entry === "onReadFailure") {
        await sim.client.onReadFailure("g1");
      } else {
        await sim.client.reconcile();
      }
      assert.equal(sim.client.grantState("g1")?.deleteReason, "long_stop", entry);
      assert.deepEqual(sim.app.holds("g1"), { records: 0, indexEntries: 0, summary: false }, entry);
    }
  });

  it("RT4 (finding 4): an unreadable journal line keeps the lease store failing closed on every later request", () => {
    let t = T0;
    const dir = tempDir("pdpp-held-rt4-");
    const journalPath = join(dir, "authority.journal");
    const store = TrainingAuthorityStore.open({
      storePath: join(dir, "t.sqlite"),
      journalPath,
      issuer: "https://as.example",
      nodeId: "n1",
      now: () => t,
    });
    store.createAuthority({ clientId: "app", grantId: "G", subjectId: "o", trainingExpiresAtMs: T0 + 30 * DAY });
    assert.equal(store.issueLease({ clientId: "app", grantId: "G" }).ok, true);
    appendFileSync(journalPath, "{not json\n");
    appendJournalEntry(journalPath, { t: "tombstone", id: "tomb1", grant_id: "G", reason: "grant_revoked", at: t } as never);
    t += MIN;
    assert.equal(store.issueLease({ clientId: "app", grantId: "G" }).ok, false);
    t += MIN;
    assert.equal(store.issueLease({ clientId: "app", grantId: "G" }).ok, false, "still closed on the second request");
    assert.throws(() =>
      TrainingAuthorityStore.open({
        storePath: join(dir, "t2.sqlite"),
        journalPath,
        issuer: "https://as.example",
        nodeId: "n2",
        now: () => t,
      })
    );
  });

  it("RT1 (finding 5): a stale replica refuses a custody-only answer too; every positive assessment is fenced", () => {
    const now = T0;
    const { as, dir, journalPath } = authority(() => now);
    reg(as, "tr", true);
    as.recordCredential({ token: "t", grantIds: ["tr"], kind: "access" });
    const snapshot = join(dir, "replica.journal");
    copyFileSync(journalPath, snapshot);
    as.end({ grantId: "tr", path: "owner_withdrawal", disposition: "delete" });
    const replica = HeldDataAuthority.open({ journalPath: snapshot, now: () => now, primaryHead: () => as.position });
    const p = replica.authenticateRead({ token: "t" });
    assert.ok(p);
    assert.throws(() => replica.status(p, ["tr"]), AuthorityUnavailableError);
  });

  it("RT5 (finding 7): an explicit acquisition list excludes the training grant's own copy unless it names it", () => {
    const dir = tempDir("pdpp-held-rt5-");
    const store = TrainingAuthorityStore.open({
      storePath: join(dir, "t.sqlite"),
      journalPath: join(dir, "j"),
      issuer: "https://as.example",
      nodeId: "n1",
      now: () => T0,
    });
    store.createAuthority({ clientId: "app", grantId: "T", subjectId: "o", trainingExpiresAtMs: T0 + DAY });
    const leased = store.issueLease({ clientId: "app", grantId: "T", acquisitionGrantIds: ["A"] });
    assert.ok(leased.ok);
    const jwks = store.jwks() as Jwks;
    const base = { iss: "https://as.example", clientId: "app", grantId: "T" };
    assert.deepEqual(validateLeaseStatic(leased.lease, jwks, { ...base, acquisitionGrantId: "T" }), {
      ok: false,
      reason: "acquisition_not_covered",
    });
    assert.deepEqual(validateLeaseStatic(leased.lease, jwks, base), { ok: false, reason: "acquisition_not_covered" });
    assert.equal(validateLeaseStatic(leased.lease, jwks, { ...base, acquisitionGrantId: "A" }).ok, true);
    const bare = store.issueLease({ clientId: "app", grantId: "T" });
    assert.ok(bare.ok);
    assert.equal(validateLeaseStatic(bare.lease, jwks, base).ok, true, "no list: the grant's own copy");
    assert.equal(validateLeaseStatic(bare.lease, jwks, { ...base, acquisitionGrantId: "A" }).ok, false);
  });

  it("RT2 (finding 8): a per-grant error or a missing entry is a failed attempt, retried within the retry interval", async () => {
    for (const results of [[{ grant_id: "g", error: "invalid_grant" as const }], []]) {
      let t = T0;
      const app = new ToyApp();
      const client = new HeldDataClient({
        now: () => t,
        status: async () => ({ ok: true, results }),
        store: app,
        policy: { retryMs: HOUR },
      });
      app.attach(client);
      app.sync("g", [{ id: "r", stream: "messages", text: "x" }]);
      t += MIN;
      const sent = t;
      await client.reconcile();
      assert.equal(client.nextAttemptAt, sent + HOUR, JSON.stringify(results));
    }
  });

  it("C1a (finding 9): HTTP 429 with Retry-After is a failed attempt, retried after the server-directed wait; a late answer pauses then resumes use", async () => {
    let t = T0;
    const app = new ToyApp();
    let mode: "ok" | "429" = "ok";
    const as = authority(() => t).as;
    reg(as, "g");
    as.recordCredential({ token: "tok", grantIds: ["g"], kind: "access" });
    let delayMs = 0;
    let pausedDuringDelivery: boolean | null = null;
    const client: HeldDataClient = new HeldDataClient({
      now: () => t,
      store: app,
      policy: { pauseThresholdMs: 48 * HOUR, retryMs: HOUR },
      status: async () => {
        if (mode === "429") {
          return { ok: false, reason: "http_429", retryAfterMs: 2 * HOUR };
        }
        const p = as.authenticateRead({ token: "tok" });
        const results = p ? as.status(p, ["g"]) : [];
        t += delayMs;
        if (delayMs > 0) {
          pausedDuringDelivery = !client.canUse("g").ok;
        }
        return { ok: true, results };
      },
    });
    app.attach(client);
    app.sync("g", [{ id: "r", stream: "messages", text: "x" }]);
    await client.reconcile();
    const s = t;
    mode = "429";
    t += MIN;
    await client.reconcile();
    assert.equal(client.nextAttemptAt, t + 2 * HOUR);
    // RT14 trace: retry at s+47h59m, answer delivered two minutes later.
    mode = "ok";
    t = s + 47 * HOUR + 59 * MIN;
    delayMs = 2 * MIN;
    const req = client.reconcile();
    await req;
    assert.equal(t, s + 48 * HOUR + MIN);
    assert.equal(pausedDuringDelivery, true, "use pauses at the deadline while the answer is in flight");
    assert.equal(client.canUse("g").ok, true, "use resumes once the positive answer arrives");
    // Between the deadline and delivery the gate was closed: the freshness origin is the send time.
    assert.equal(client.grantState("g")?.freshnessOrigin, s + 47 * HOUR + 59 * MIN);
  });

  it("RT9 (finding 11): retained, a corrected retained, then completed are all kept; the owner sees completion", () => {
    let t = T0;
    const { as } = authority(() => t);
    reg(as, "g");
    const op = as.requestErasure({ grantId: "g", origin: "owner_withdrawal" }).operationId;
    t += DAY;
    assert.equal(as.report({ clientId: "app", grantId: "g", operationId: op, kind: "retained", detail: "until=2027" }), true);
    t += DAY;
    assert.equal(as.report({ clientId: "app", grantId: "g", operationId: op, kind: "retained", detail: "until=2028" }), true);
    t += DAY;
    assert.equal(as.report({ clientId: "app", grantId: "g", operationId: op, kind: "completion" }), true);
    const e = as.ownerView("g", 30 * DAY)?.erasures[0];
    assert.equal(e?.completion?.outcome, "deleted");
    assert.deepEqual(
      e?.retained.map((r) => r.detail),
      ["until=2027", "until=2028"]
    );
  });

  it("RT11 (finding 11): a downstream holder keeps an erasure terminal under reordered delivery and merges deadlines conservatively", () => {
    let t = T0;
    const sub = new ToySubprocessor(() => t);
    sub.receive("g", 3);
    const positive = { grantId: "g", issuedAt: T0, useUntil: T0 + 7 * DAY, erasures: [], deleteAllBy: null };
    const erase = {
      grantId: "g",
      issuedAt: T0 + HOUR,
      useUntil: null,
      erasures: [{ operationId: "op", scope: { streams: "all" as const }, deleteBy: T0 + 30 * DAY }],
      deleteAllBy: T0 + 30 * DAY,
    };
    sub.relay(positive);
    sub.relay(erase);
    sub.relay({ ...positive, useUntil: T0 + 9 * DAY });
    assert.equal(sub.canUse("g"), false);
    t = T0 + 31 * DAY;
    sub.tick();
    assert.equal(sub.held.has("g"), false);
  });

  it("finding 1 (RT7): a same-epoch rollback that drops an acknowledged terminal event is detected; the shared lease store fails closed too", () => {
    let t = T0;
    const { as, dir, journalPath, epochMarkerPath } = authority(() => t);
    reg(as, "g");
    as.recordCredential({ token: "tok", grantIds: ["g"], kind: "access" });
    const prefix = join(dir, "prefix.journal");
    copyFileSync(journalPath, prefix);
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
    copyFileSync(prefix, journalPath);
    const reopened = HeldDataAuthority.open({ journalPath, now: () => t, epochMarkerPath });
    assert.equal(reopened.lost, true);
    assert.throws(() => reopened.authenticateRead({ token: "tok" }), AuthorityUnavailableError);

    // Lease store on the same journal and evidence.
    const d2 = authority(() => t);
    const leases = TrainingAuthorityStore.open({
      storePath: join(d2.dir, "t.sqlite"),
      journalPath: d2.journalPath,
      issuer: "https://as.example",
      nodeId: "n1",
      now: () => t,
    });
    leases.createAuthority({ clientId: "app", grantId: "T", subjectId: "o", trainingExpiresAtMs: T0 + DAY });
    const before = join(d2.dir, "before.journal");
    copyFileSync(d2.journalPath, before);
    leases.withdraw({ grantId: "T", reason: "training_withdrawn" });
    copyFileSync(before, d2.journalPath);
    t += MIN;
    const reopenedLeases = TrainingAuthorityStore.open({
      storePath: join(d2.dir, "t3.sqlite"),
      journalPath: d2.journalPath,
      issuer: "https://as.example",
      nodeId: "n3",
      now: () => t,
    });
    assert.deepEqual(reopenedLeases.issueLease({ clientId: "app", grantId: "T" }), { ok: false, reason: "unavailable" });
  });
});
