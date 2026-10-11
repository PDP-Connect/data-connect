// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToyApp } from "../examples/held-data-toy-app/app.ts";
import { MemoryClientCheckpointStorage } from "../lib/held-data/checkpoint.ts";
import { HeldDataClient, type HeldRecordRef, type HeldStore, type StatusTransport } from "../lib/held-data/client.ts";
import { DAY, T0 } from "./helpers/held-data-sim.ts";

const unavailable: StatusTransport = async () => ({ ok: false, reason: "unreachable" });
const permitted = (now: () => number): StatusTransport => async (ids) => ({
  ok: true,
  results: ids.map((grant_id) => ({
    as_position: 1, assessed_at: now(), ending: null, erasures: [], expires_at: null, grant_id,
    grant_state: "active" as const, ordinary_use: "permitted" as const,
  })),
});

class Store implements HeldStore {
  readonly held = new Set<string>();
  readonly disposedRecords: string[] = [];
  grantIds() { return this.held; }
  dispose(grantId: string) { this.held.delete(grantId); }
  disposeRecords(_grantId: string, records: readonly HeldRecordRef[]) {
    this.disposedRecords.push(...records.map((r) => `${r.id}@${r.version ?? ""}`));
  }
}

const ceiling = 10 * DAY;
const make = (t: () => number, storage: MemoryClientCheckpointStorage, store: Store, initialize = false) =>
  new HeldDataClient({
    now: t, status: unavailable, storage, store, initialize, policy: { retentionCeilingMs: ceiling },
  });

describe("client record clocks in the durable checkpoint", () => {
  it("a restart does not move a record clock across grants, or the ambiguous-version clock", () => {
    let t = T0;
    const storage = new MemoryClientCheckpointStorage();
    const store = new Store();
    const c1 = make(() => t, storage, store, true);
    assert.equal(c1.acquireRecords("g1", [{ id: "r", stream: "s" }]).length, 1);
    store.held.add("g1");
    t += 6 * DAY;
    const c2 = make(() => t, storage, store);
    assert.equal(c2.acquireRecords("g2", [{ id: "r", stream: "s", version: "v2" }]).length, 1);
    store.held.add("g2");
    const [rec] = c2.grantState("g2")?.records.values() ?? [];
    assert.equal(rec?.firstAcquiredAt, T0, "the unknown-version clock carries to the versioned copy");
    t += 4 * DAY;
    const c3 = make(() => t, storage, store);
    assert.deepEqual(c3.acquireRecords("g3", [{ id: "r", stream: "s", version: "v2" }]), []);
    void c3.canUse("g2");
    assert.ok(store.disposedRecords.includes("r@v2"));
  });

  it("a later record in the same grant is not disposed at the first record's ceiling", () => {
    let t = T0;
    const storage = new MemoryClientCheckpointStorage();
    const store = new Store();
    const c = make(() => t, storage, store, true);
    c.acquireRecords("g", [{ id: "a", stream: "s" }]);
    t += 5 * DAY;
    c.acquireRecords("g", [{ id: "b", stream: "s" }]);
    t += 5 * DAY;
    void c.canUse("g");
    assert.deepEqual(store.disposedRecords, ["a@"]);
    assert.equal(c.grantState("g")?.deletedAt, null);
    const restarted = make(() => t, storage, store);
    assert.deepEqual([...(restarted.grantState("g")?.records.keys() ?? [])].length, 1);
  });

  it("an old checkpoint without record fields restores as untracked with the grant ceiling", () => {
    let t = T0;
    const storage = new MemoryClientCheckpointStorage();
    const store = new Store();
    const c = make(() => t, storage, store, true);
    c.acquire("g");
    store.held.add("g");
    const old = JSON.parse(storage.read() as string);
    old.acquisitions = undefined;
    for (const g of old.grants) {
      g.records = undefined;
      g.recordsTracked = undefined;
      g.readState = undefined;
    }
    storage.write(JSON.stringify(old));
    t += ceiling;
    const restored = make(() => t, storage, store);
    assert.equal(restored.grantState("g")?.recordsTracked, false);
    void restored.canUse("g");
    assert.equal(restored.grantState("g")?.deleteReason, "retention_ceiling");
    assert.equal(store.held.has("g"), false);
  });

  it("a failed clock write keeps nothing, and a lost checkpoint fails closed", () => {
    const t = T0;
    const storage = new MemoryClientCheckpointStorage();
    const store = new Store();
    const c = make(() => t, storage, store, true);
    store.held.add("g");
    storage.write = () => {
      throw new Error("disk full");
    };
    assert.deepEqual(c.acquireRecords("g", [{ id: "r", stream: "s" }]), []);
    assert.equal(store.held.size, 0, "inventory disposed when the clock cannot be saved");

    store.held.add("g");
    const lost = make(() => t, new MemoryClientCheckpointStorage(), store);
    assert.deepEqual(lost.acquireRecords("g", [{ id: "r", stream: "s" }]), []);
    assert.equal(lost.canUse("g").ok, false);
    assert.equal(store.held.size, 0);
  });

  it("a record disposed at its ceiling and restored from an older data backup is swept again before use", async () => {
    let t = T0;
    const storage = new MemoryClientCheckpointStorage();
    const policy = { retentionCeilingMs: ceiling };
    const app = new ToyApp();
    const c1 = new HeldDataClient({ initialize: true, now: () => t, status: permitted(() => t), storage, store: app, policy });
    app.attach(c1);
    app.sync("g", [{ id: "a", stream: "s", text: "alpha" }]);
    t += 5 * DAY;
    app.sync("g", [{ id: "b", stream: "s", text: "bravo" }]);
    const backup = structuredClone(app.records.get("g") ?? []);
    assert.equal(backup.length, 2);
    t += 5 * DAY;
    void c1.canUse("g");
    assert.deepEqual(app.records.get("g")?.map((r) => r.id), ["b"], "a is disposed at day 10");

    // The data backup is older than the checkpoint: it carries a again. The checkpoint stays current.
    const restored = new ToyApp();
    restored.records.set("g", structuredClone(backup));
    restored.reindex("g");
    t += DAY;
    const c2 = new HeldDataClient({ now: () => t, status: permitted(() => t), storage, store: restored, policy });
    restored.attach(c2);
    await c2.reconcile();
    assert.deepEqual(restored.search("g", "alpha"), [], "a is past its ceiling and must not be searchable");
    assert.deepEqual(restored.records.get("g")?.map((r) => r.id), ["b"]);
    assert.deepEqual(restored.search("g", "bravo"), ["g:b"]);
  });

  it("reacquiring a legacy copy after its retention ceiling does not restart the ceiling", () => {
    let t = T0;
    const store = new Store();
    const c = new HeldDataClient({
      now: () => t, status: unavailable, store, initialize: true, policy: { retentionCeilingMs: ceiling, longStopMs: null },
    });
    assert.equal(c.acquire("g"), true);
    store.held.add("g");
    t += ceiling;
    void c.canUse("g");
    assert.equal(c.grantState("g")?.deleteReason, "retention_ceiling");
    assert.equal(store.held.has("g"), false);

    t += DAY;
    const kept = c.acquire("g");
    if (kept) {
      store.held.add("g");
    }
    const by = c.deleteBy("g");
    assert.ok(!kept || (by !== null && by <= T0 + ceiling), `reacquired copy must stay past its original ceiling; deleteBy=${by === null ? by : (by - T0) / DAY}d`);
    void c.canUse("g");
    assert.equal(store.held.has("g"), false, "the reacquired legacy copy is disposed at once");
  });
});
