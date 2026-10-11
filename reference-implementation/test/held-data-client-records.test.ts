// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryClientCheckpointStorage } from "../lib/held-data/checkpoint.ts";
import { HeldDataClient, type HeldRecordRef, type HeldStore, type StatusTransport } from "../lib/held-data/client.ts";
import { DAY, T0 } from "./helpers/held-data-sim.ts";

const unavailable: StatusTransport = async () => ({ ok: false, reason: "unreachable" });

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
});
