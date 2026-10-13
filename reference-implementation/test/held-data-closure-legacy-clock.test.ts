// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Class: a legacy (identity-less) copy's first-acquisition clock must survive every path that
 * retires it. Core: "Rereading, transforming, relabeling, moving, or deriving data never restarts
 * that clock", and an uncertain mapping "MUST NOT extend a deadline".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryClientCheckpointStorage } from "../lib/held-data/checkpoint.ts";
import { HeldDataClient, type HeldRecordRef, type HeldStore, type StatusTransport } from "../lib/held-data/client.ts";
import { DAY, HOUR, T0 } from "./helpers/held-data-sim.ts";

const unavailable: StatusTransport = async () => ({ ok: false, reason: "unreachable" });

/** A store that lists exactly what it holds, as the migration requires. */
class ListedStore implements HeldStore {
  readonly rows: HeldRecordRef[] = [];
  grantIds() { return this.rows.length ? ["g"] : []; }
  recordRefs(): HeldRecordRef[] { return [...this.rows]; }
  dispose() { this.rows.length = 0; }
  disposeRecords(_grantId: string, records: readonly HeldRecordRef[]) {
    for (const r of records) {
      const i = this.rows.findIndex((x) => x.id === r.id);
      if (i >= 0) this.rows.splice(i, 1);
    }
  }
}

const r: HeldRecordRef = { id: "r", stream: "s" };
const policy = { retentionCeilingMs: 2 * DAY };

function ceilingDisposedLegacy(t: { v: number }, storage?: MemoryClientCheckpointStorage) {
  const store = new ListedStore();
  const make = (initialize: boolean) => new HeldDataClient({
    now: () => t.v, status: unavailable, store, policy, initialize, ...(storage ? { storage } : {}),
  });
  const c = make(true);
  assert.equal(c.acquire("g"), true);
  store.rows.push(r);
  t.v = T0 + 2 * DAY;
  void c.canUse("g");
  assert.equal(c.grantState("g")?.deleteReason, "retention_ceiling");
  assert.equal(store.rows.length, 0);
  return { c, store, make };
}

describe("legacy clock survives migration after disposal", () => {
  it("a record re-delivered after the legacy copy's ceiling disposal is not kept", () => {
    const t = { v: T0 };
    const { c, store } = ceilingDisposedLegacy(t);
    t.v = T0 + 3 * DAY;
    const kept = c.acquireRecords("g", [r]);
    store.rows.push(...kept);
    assert.deepEqual(kept, [], "the copy was first acquired on day 0; its ceiling (day 2) has passed and the clock outlives the disposal");
    assert.equal(store.rows.length, 0);
  });

  it("the same, after a restart restores the checkpoint", () => {
    const t = { v: T0 };
    const storage = new MemoryClientCheckpointStorage();
    const { make } = ceilingDisposedLegacy(t, storage);
    t.v = T0 + 3 * DAY;
    const restarted = make(false);
    assert.deepEqual(restarted.acquireRecords("g", [r]), []);
  });

  it("a legacy copy that the store no longer lists (empty inventory) does not get a fresh clock", () => {
    const t = { v: T0 };
    const store = new ListedStore();
    const c = new HeldDataClient({
      now: () => t.v, status: unavailable, store, initialize: true, policy: { retentionCeilingMs: 2 * DAY },
    });
    assert.equal(c.acquire("g"), true);
    t.v = T0 + DAY + 12 * HOUR;
    const kept = c.acquireRecords("g", [r]);
    assert.equal(kept.length, 1);
    assert.ok((c.deleteBy("g") ?? Number.POSITIVE_INFINITY) <= T0 + 2 * DAY, `deleteBy=${((c.deleteBy("g") ?? 0) - T0) / DAY}d`);
  });
});
