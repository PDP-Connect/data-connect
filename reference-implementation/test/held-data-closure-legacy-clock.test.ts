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
const policy = { retentionCeilingMs: 2 * DAY, longStopMs: DAY };

function longStopDisposedLegacy(t: { v: number }, storage?: MemoryClientCheckpointStorage) {
  const store = new ListedStore();
  const make = (initialize: boolean) => new HeldDataClient({
    now: () => t.v, status: unavailable, store, policy, initialize, ...(storage ? { storage } : {}),
  });
  const c = make(true);
  assert.equal(c.acquire("g"), true);
  store.rows.push(r);
  t.v = T0 + DAY;
  void c.canUse("g");
  assert.equal(c.grantState("g")?.deleteReason, "long_stop");
  assert.equal(store.rows.length, 0);
  return { c, store, make };
}

describe("legacy clock survives migration after disposal", () => {
  it("a record re-delivered after the legacy copy's long-stop disposal and past its ceiling is not kept", () => {
    const t = { v: T0 };
    const { c, store } = longStopDisposedLegacy(t);
    t.v = T0 + 3 * DAY;
    const kept = c.acquireRecords("g", [r]);
    store.rows.push(...kept);
    assert.deepEqual(kept, [], "the copy was first acquired on day 0; its ceiling (day 2) has passed");
    assert.equal(store.rows.length, 0);
  });

  it("the same, after a restart restores the checkpoint", () => {
    const t = { v: T0 };
    const storage = new MemoryClientCheckpointStorage();
    const { make } = longStopDisposedLegacy(t, storage);
    t.v = T0 + 3 * DAY;
    const restarted = make(false);
    assert.deepEqual(restarted.acquireRecords("g", [r]), []);
  });

  it("a record re-delivered between the long-stop and the ceiling keeps the original ceiling", () => {
    const t = { v: T0 };
    const { c } = longStopDisposedLegacy(t);
    t.v = T0 + DAY + 12 * HOUR;
    assert.equal(c.acquire("g"), true, "Core permits reading again after the disposal");
    t.v += HOUR;
    assert.equal(c.acquireRecords("g", [r]).length, 1);
    const [rec] = c.grantState("g")?.records.values() ?? [];
    assert.equal(rec?.firstAcquiredAt, T0, "the record counts from the first acquisition, not the reread");
    assert.ok((c.deleteBy("g") ?? Number.POSITIVE_INFINITY) <= T0 + 2 * DAY);
  });

  it("a legacy copy that the store no longer lists (empty inventory) does not get a fresh clock", () => {
    const t = { v: T0 };
    const store = new ListedStore();
    const c = new HeldDataClient({
      now: () => t.v, status: unavailable, store, initialize: true, policy: { retentionCeilingMs: 2 * DAY, longStopMs: null },
    });
    assert.equal(c.acquire("g"), true);
    t.v = T0 + DAY + 12 * HOUR;
    const kept = c.acquireRecords("g", [r]);
    assert.equal(kept.length, 1);
    assert.ok((c.deleteBy("g") ?? Number.POSITIVE_INFINITY) <= T0 + 2 * DAY, `deleteBy=${((c.deleteBy("g") ?? 0) - T0) / DAY}d`);
  });
});
