// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToyApp, ToySubprocessor } from "../examples/held-data-toy-app/app.ts";
import { FileClientCheckpointStorage, MemoryClientCheckpointStorage } from "../lib/held-data/checkpoint.ts";
import type { StatusTransport } from "../lib/held-data/client.ts";
import { HeldDataClient } from "../lib/held-data/client.ts";
import { DAY, HOUR, T0, tempDir } from "./helpers/held-data-sim.ts";

const unavailable: StatusTransport = async () => ({ ok: false, reason: "unreachable" });
const disposalCrash = /power off before deletion/;

function savedErasure(storage: MemoryClientCheckpointStorage): {
  receivedAt: number;
  disposedAt: number | null;
  disposalPending: boolean;
} {
  const raw = storage.read();
  assert.ok(raw);
  const { grants } = JSON.parse(raw);
  const [grant] = grants;
  const [entry] = grant.erasures;
  const [, erasure] = entry;
  return erasure;
}

const record = [{ id: "r", stream: "messages", text: "hello world" }];

function positive(now: () => number, position = 1): StatusTransport {
  return async (ids) => ({
    ok: true,
    results: ids.map((grant_id) => ({
      as_position: position,
      assessed_at: now(),
      ending: null,
      erasures: [],
      expires_at: null,
      grant_id,
      grant_state: "active",
      ordinary_use: "permitted",
    })),
  });
}

describe("client safety (RT6, RT10 and persisted state)", () => {
  it("RT6: a clock moved back ten days never revives use or extends disposal", async () => {
    let t = T0;
    const app = new ToyApp();
    const client = new HeldDataClient({ now: () => t, status: positive(() => t), store: app });
    app.attach(client);
    app.sync("g", record);
    await client.reconcile();
    const deadline = client.deleteBy("g");
    t += 8 * DAY;
    assert.equal(client.canUse("g").ok, false);
    t -= 10 * DAY;
    assert.equal(client.canUse("g").ok, false, "rollback must not revive the old assessment");
    await client.tick();
    assert.equal(app.holds("g").records, 0, "uncertain disposal deadline is treated as due");
    assert.ok(client.deleteBy("g") === null || client.deleteBy("g") === deadline);
  });

  it("rollback observed on the final use-gate time read cannot license one last use", async () => {
    let armed = false;
    let reads = 0;
    const now = () => {
      if (armed) {
        reads += 1;
      }
      return armed && reads >= 2 ? T0 - 10 * DAY : T0;
    };
    const app = new ToyApp();
    const c = new HeldDataClient({ now, status: positive(() => T0), store: app });
    app.attach(c);
    app.sync("g", record);
    await c.reconcile();
    armed = true;
    assert.equal(c.canUse("g").ok, false, "rollback detected inside the gate must invalidate its decision");
    assert.equal(app.holds("g").records, 0);
  });

  it("suspension observed on the final use-gate time read requires reconciliation", async () => {
    let armed = false;
    let reads = 0;
    const now = () => {
      if (armed) {
        reads += 1;
      }
      return armed && reads >= 2 ? T0 + 2 * DAY : T0;
    };
    const app = new ToyApp();
    const c = new HeldDataClient({ monotonicMs: () => 0, now, status: positive(() => T0), store: app });
    app.attach(c);
    app.sync("g", record);
    await c.reconcile();
    armed = true;
    assert.equal(c.canUse("g").ok, false, "suspension detected inside the gate must invalidate its decision");
  });

  it("checkpoint persists first receipt, deadlines, positions and assessment before restart", async () => {
    let t = T0;
    const storage = new MemoryClientCheckpointStorage();
    const app = new ToyApp();
    const c = new HeldDataClient({
      initialize: true,
      now: () => t,
      policy: { disposeAt: "deadline" },
      status: positive(() => t, 7),
      storage,
      store: app,
    });
    app.attach(c);
    app.sync("g", record);
    await c.reconcile();
    t += DAY;
    c.ownerDelete("g");
    assert.ok(storage.read(), "receipt must be checkpointed synchronously");
    const before = c.grantState("g");
    const nextAttempt = c.nextAttemptAt;
    const restarted = new HeldDataClient({ now: () => t, status: unavailable, storage, store: app });
    app.attach(restarted);
    assert.deepEqual(restarted.grantState("g")?.erasures, before?.erasures);
    assert.equal(restarted.grantState("g")?.firstAcquiredAt, T0);
    assert.equal(restarted.grantState("g")?.freshnessOrigin, T0);
    assert.equal(restarted.grantState("g")?.lastPosition, 7);
    assert.equal(restarted.nextAttemptAt, nextAttempt);
    assert.equal(restarted.deleteBy("g"), c.deleteBy("g"));
    t += 30 * DAY;
    await restarted.tick();
    assert.deepEqual(app.holds("g"), { indexEntries: 0, records: 0, summary: false });
  });

  it("RT6: replacing a file checkpoint with an older copy fails closed and cannot reacquire", async () => {
    let t = T0;
    const path = join(tempDir("held-client-state-"), "checkpoint");
    const witness = join(tempDir("held-client-witness-"), "witness");
    const storage = new FileClientCheckpointStorage(path, witness);
    const app = new ToyApp();
    const c = new HeldDataClient({ initialize: true, now: () => t, status: positive(() => t), storage, store: app });
    app.attach(c);
    app.sync("g", record);
    await c.reconcile();
    const older = readFileSync(path, "utf8");
    t += DAY;
    c.ownerDelete("g");
    writeFileSync(path, older);
    app.records.set("g", record);
    app.reindex("g");
    const restored = new HeldDataClient({ now: () => t, status: positive(() => t), storage, store: app });
    app.attach(restored);
    assert.equal(restored.canUse("g").ok, false);
    await restored.onResume();
    app.sync("g", record);
    assert.equal(restored.canUse("g").ok, false);
    assert.equal(app.holds("g").records, 0, "lost clocks cannot become a new acquisition");
  });

  it("missing or corrupt checkpoint treats existing copies and derivatives as due", async () => {
    for (const damage of ["missing", "corrupt", "both_missing"] as const) {
      const path = join(tempDir("held-client-damaged-"), "checkpoint");
      const witness = join(tempDir("held-client-evidence-"), "witness");
      const storage = new FileClientCheckpointStorage(path, witness);
      const app = new ToyApp();
      const c = new HeldDataClient({ initialize: true, now: () => T0, status: unavailable, storage, store: app });
      app.attach(c);
      app.sync("g", record);
      if (damage === "corrupt") {
        writeFileSync(path, "{invalid");
      } else {
        rmSync(path);
      }
      if (damage === "both_missing") {
        rmSync(witness);
      }
      const restarted = new HeldDataClient({ now: () => T0, status: positive(() => T0), storage, store: app });
      app.attach(restarted);
      // biome-ignore lint/performance/noAwaitInLoops: each damage mode owns a separate store and journey.
      await restarted.onResume();
      app.sync("g", record);
      assert.equal(restarted.canUse("g").ok, false, damage);
      assert.deepEqual(app.holds("g"), { indexEntries: 0, records: 0, summary: false }, damage);
    }
  });

  it("RT10: token assessment before first acquisition uses original send time, including after restart", async () => {
    let t = T0;
    const storage = new MemoryClientCheckpointStorage();
    const app = new ToyApp();
    const c = new HeldDataClient({ initialize: true, now: () => t, status: unavailable, storage, store: app });
    const sentAt = t;
    assert.equal(c.beginTokenRequest("first"), sentAt);
    t += 3 * DAY;
    const afterRequestRestart = new HeldDataClient({ now: () => t, status: unavailable, storage, store: app });
    assert.equal(afterRequestRestart.beginTokenRequest("first"), sentAt, "retry retains original request origin");
    afterRequestRestart.onTokenResponse({ grantIds: ["g"], requestId: "first", sentAt: t });
    const restarted = new HeldDataClient({ now: () => t, status: unavailable, storage, store: app });
    app.attach(restarted);
    app.sync("g", record);
    await restarted.reconcile();
    assert.equal(restarted.grantState("g")?.freshnessOrigin, sentAt);
    assert.equal(restarted.deleteBy("g"), sentAt + 90 * DAY, "acquisition + long-stop is too late");
    assert.equal(restarted.canUse("g").ok, true);
    t = sentAt + 7 * DAY;
    assert.equal(restarted.canUse("g").ok, false);
    c.onTokenResponse({ grantIds: ["recovery"], lifecycleRecovery: true, sentAt: t });
    assert.equal(c.grantState("recovery"), undefined);
  });

  it("write-ahead: failed checkpoint cannot license storage, use, relay or reports", async () => {
    const storage = new MemoryClientCheckpointStorage();
    const app = new ToyApp();
    let fail = false;
    let reports = 0;
    let relays = 0;
    const write = storage.write.bind(storage);
    storage.write = (value) => {
      if (fail) {
        throw new Error("disk full");
      }
      write(value);
    };
    const c = new HeldDataClient({
      downstream: [
        {
          relay: () => {
            relays += 1;
          },
        },
      ],
      initialize: true,
      now: () => T0,
      report: () => {
        reports += 1;
        return Promise.resolve(true);
      },
      status: positive(() => T0),
      storage,
      store: app,
    });
    app.attach(c);
    fail = true;
    app.sync("g", record);
    assert.equal(app.holds("g").records, 0, "acquisition must be durable before app stores the copy");
    await c.reconcile();
    c.ownerDelete("g");
    assert.equal(c.canUse("g").ok, false);
    assert.equal(reports, 0);
    assert.equal(relays, 0);
  });

  it("toy app restart preserves paused use and disposes overdue restored data before an answer", async () => {
    let t = T0;
    const storage = new MemoryClientCheckpointStorage();
    const app = new ToyApp();
    const c = new HeldDataClient({ initialize: true, now: () => t, status: positive(() => t), storage, store: app });
    app.attach(c);
    app.sync("g", record);
    await c.reconcile();
    assert.deepEqual(app.search("g", "hello"), ["g:r"]);
    t += 2 * DAY;
    const restoredApp = new ToyApp();
    const restoredRecords = app.records.get("g");
    assert.ok(restoredRecords);
    restoredApp.records.set("g", structuredClone(restoredRecords));
    restoredApp.reindex("g");
    const restarted = new HeldDataClient({ now: () => t, status: unavailable, storage, store: restoredApp });
    restoredApp.attach(restarted);
    assert.equal(restoredApp.search("g", "hello"), null);
    restoredApp.sync("g", record);
    assert.equal(restarted.grantState("g")?.firstAcquiredAt, T0);
    t = T0 + 91 * DAY;
    let observed = false;
    const afterPowerOff = new HeldDataClient({
      now: () => t,
      status: (ids) => {
        observed = true;
        assert.equal(restoredApp.holds("g").records, 0, "dispose precedes new assessment");
        return positive(() => t)(ids);
      },
      storage,
      store: restoredApp,
    });
    restoredApp.attach(afterPowerOff);
    await afterPowerOff.onResume();
    assert.equal(observed, false, "disposed copies need no query");
    assert.equal(afterPowerOff.grantState("g")?.deleteReason, "long_stop");
    assert.equal(restoredApp.search("g", "hello"), null);
  });

  it("crash during disposal replays persisted intent; receipt and completion are written before reports", async () => {
    const storage = new MemoryClientCheckpointStorage();
    const app = new ToyApp();
    let crash = true;
    const dispose = app.dispose.bind(app);
    app.dispose = (grantId, scope) => {
      const e = savedErasure(storage);
      if (app.holds(grantId).records > 0) {
        assert.equal(e.disposalPending, true);
        if (crash) {
          throw new Error("power off before deletion");
        }
      }
      dispose(grantId, scope);
    };
    const reportKinds: string[] = [];
    const report = (r: { kind: string }) => {
      const e = savedErasure(storage);
      assert.equal(e.receivedAt, T0);
      if (r.kind === "completion") {
        assert.equal(e.disposedAt, T0);
      }
      reportKinds.push(r.kind);
      return Promise.resolve(true);
    };
    const status: StatusTransport = async () => ({
      ok: true,
      results: [
        {
          as_position: 4,
          assessed_at: T0,
          ending: null,
          erasures: [{ accepted_at: T0, operation_id: "erase", scope: { streams: "all" } }],
          expires_at: null,
          grant_id: "g",
          grant_state: "ended",
          ordinary_use: "stopped",
        },
      ],
    });
    const c = new HeldDataClient({ initialize: true, now: () => T0, report, status, storage, store: app });
    app.attach(c);
    app.sync("g", record);
    await assert.rejects(c.reconcile(), disposalCrash);
    assert.equal(savedErasure(storage).disposedAt, null);
    crash = false;
    const restarted = new HeldDataClient({ now: () => T0, report, status: unavailable, storage, store: app });
    app.attach(restarted);
    await restarted.onResume();
    assert.equal(app.holds("g").records, 0);
    assert.deepEqual(reportKinds, ["receipt", "completion"]);
    assert.equal(restarted.grantState("g")?.erasures.get("erase")?.completionReported, true);
  });

  it("a failed disposal checkpoint sweeps every due grant and keeps use closed", async () => {
    let t = T0;
    const storage = new MemoryClientCheckpointStorage();
    const app = new ToyApp();
    const c = new HeldDataClient({ initialize: true, now: () => t, status: positive(() => t), storage, store: app });
    app.attach(c);
    app.sync("a", record);
    app.sync("b", record);
    await c.reconcile();
    t += 91 * DAY;
    storage.write = () => {
      throw new Error("disk full during disposal");
    };
    c.canUse("a");
    assert.equal(
      app.holds("a").records + app.holds("b").records,
      0,
      "one failed write must not leave another due copy"
    );
    assert.equal(c.canUse("b").ok, false);
  });

  it("token processing-permission evidence stays restrictive before and after acquisition", () => {
    const app = new ToyApp();
    const c = new HeldDataClient({ now: () => T0, status: unavailable, store: app });
    app.attach(c);
    app.sync("held", record);
    c.onTokenResponse({ grantIds: ["held", "pending"], processingPermissionGrantIds: ["held", "pending"], sentAt: T0 });
    c.onTokenResponse({ grantIds: ["pending"], processingPermissionGrantIds: [], sentAt: T0 });
    c.acquire("pending", { processingPermission: false });
    assert.equal(c.canUse("held").ok, false, "authenticated permission restricts an already-held grant");
    assert.equal(c.canUse("pending").ok, false, "an older or empty permission list cannot relax cached evidence");
  });

  it("a clock rollback in one downstream callback cannot relay positive use to the next", async () => {
    let t = T0;
    let secondUntil: number | null | undefined;
    const app = new ToyApp();
    const c = new HeldDataClient({
      downstream: [
        {
          relay: () => {
            t -= DAY;
          },
        },
        {
          relay: (notice) => {
            secondUntil = notice.useUntil;
          },
        },
      ],
      now: () => t,
      status: positive(() => t),
      store: app,
    });
    app.attach(c);
    app.sync("g", record);
    await c.reconcile();
    assert.equal(secondUntil, null, "relay must check authority after a reentrant clock discontinuity");
  });

  it("a positive status answer delayed across the old long-stop cannot cancel overdue disposal", async () => {
    let t = T0;
    let delayed = false;
    const app = new ToyApp();
    const status: StatusTransport = (ids) => {
      const answer = positive(() => t)(ids);
      if (delayed) {
        t += 2 * DAY;
      }
      return answer;
    };
    const c = new HeldDataClient({ now: () => t, status, store: app });
    app.attach(c);
    app.sync("g", record);
    await c.reconcile();
    t += 89 * DAY;
    delayed = true;
    await c.reconcile();
    assert.equal(app.holds("g").records, 0, "new assessment must not cancel a disposal deadline passed in flight");
    assert.equal(c.grantState("g")?.deleteReason, "long_stop");
  });

  it("completed partial erasure is replayed against restored data without changing receipt or completion", async () => {
    const storage = new MemoryClientCheckpointStorage();
    const app = new ToyApp();
    const records = [...record, { id: "contact", stream: "contacts", text: "alice" }];
    const status: StatusTransport = async () => ({
      ok: true,
      results: [
        {
          as_position: 2,
          assessed_at: T0,
          ending: null,
          erasures: [{ accepted_at: T0, operation_id: "partial", scope: { streams: ["messages"] } }],
          expires_at: null,
          grant_id: "g",
          grant_state: "active",
          ordinary_use: "permitted",
        },
      ],
    });
    const c = new HeldDataClient({ initialize: true, now: () => T0, status, storage, store: app });
    app.attach(c);
    app.sync("g", records);
    await c.reconcile();
    const completed = c.grantState("g")?.erasures.get("partial");
    assert.equal(app.holds("g").records, 1);
    app.records.set("g", records);
    app.reindex("g");
    const restored = new HeldDataClient({ now: () => T0, status: unavailable, storage, store: app });
    app.attach(restored);
    await restored.onResume();
    assert.equal(app.holds("g").records, 1, "completed partial disposal must replay against backup rows");
    assert.deepEqual(restored.grantState("g")?.erasures.get("partial"), completed);
    app.sync("g", records);
    assert.equal(app.holds("g").records, 1, "resync must not reintroduce a completed partial erasure");
  });

  it("monotonic progress survives wall rollback and a detected suspend never extends deadlines", async () => {
    let wall = T0;
    let mono = 0;
    const app = new ToyApp();
    const c = new HeldDataClient({
      monotonicMs: () => mono,
      now: () => wall,
      status: positive(() => wall),
      store: app,
    });
    app.attach(c);
    app.sync("g", record);
    await c.reconcile();
    mono += HOUR;
    wall += HOUR;
    assert.equal(c.canUse("g").ok, true);
    wall += 2 * DAY;
    assert.equal(c.canUse("g").ok, false, "wall time includes suspension even if monotonic time omits it");
  });

  it("toy subprocessor: the use gate enforces a relayed deleteAllBy itself, without a tick", () => {
    let t = T0;
    const sub = new ToySubprocessor(() => t);
    sub.receive("g", 1);
    sub.relay({ grantId: "g", issuedAt: T0, useUntil: T0 + 7 * DAY, deleteAllBy: T0 + 2 * DAY, erasures: [] });
    t = T0 + 2 * DAY;
    assert.equal(sub.canUse("g"), false, "use ends at deleteAllBy without a separate tick");
    const erased = new ToySubprocessor(() => t);
    erased.receive("e", 1);
    erased.relay({
      grantId: "e", issuedAt: T0, useUntil: T0 + 7 * DAY, deleteAllBy: null,
      erasures: [{ operationId: "op", scope: { streams: "all" }, deleteBy: T0 + DAY }],
    });
    assert.equal(erased.canUse("e"), false, "an erasure also closes use");
  });

  it("toy subprocessor: a clock moved back never revives use", () => {
    let t = T0;
    const other = new ToySubprocessor(() => t);
    other.receive("h", 1);
    other.relay({ grantId: "h", issuedAt: T0, useUntil: T0 + 7 * DAY, deleteAllBy: null, erasures: [] });
    t = T0 + 8 * DAY;
    assert.equal(other.canUse("h"), false);
    t = T0 + DAY;
    assert.equal(other.canUse("h"), false, "a raw clock moved back to day 1 does not revive use");
    other.tick();
    assert.equal(other.held.has("h"), true, "a rollback does not dispose anything by itself");
  });
});
