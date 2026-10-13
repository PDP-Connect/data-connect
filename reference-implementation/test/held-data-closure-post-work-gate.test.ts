// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Class: an entry point that licenses use or storage must decide after its work and its durable
 * write, on a fresh clock sample, not only before. Core: no use after a stop-use bound or a retention
 * ceiling, including in-flight work; a retention ceiling is not extended by a slow write.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToyApp } from "../examples/held-data-toy-app/app.ts";
import { HeldDataClient, type StatusTransport } from "../lib/held-data/client.ts";
import { DAY, T0 } from "./helpers/held-data-sim.ts";
import { HookStorage } from "./helpers/held-data-hook-storage.ts";

const positive = (now: () => number): StatusTransport => async (ids) => ({
  ok: true,
  results: ids.map((grant_id) => ({
    as_position: 1, assessed_at: now(), ending: null, erasures: [], expires_at: null, grant_id,
    grant_state: "active" as const, ordinary_use: "permitted" as const,
  })),
});

const record = [{ id: "r", stream: "messages", text: "hello world" }];

describe("licensing entry points re-gate after their work", () => {
  it("app.search: a slow index lookup that crosses the retention ceiling returns no hits", async () => {
    let t = T0;
    const app = new ToyApp(() => t);
    const c = new HeldDataClient({ now: () => t, status: positive(() => t), store: app, policy: { retentionCeilingMs: 7 * DAY } });
    app.attach(c);
    app.sync("g", [{ id: "r", stream: "messages", text: "hello world" }]);
    await c.reconcile();
    assert.deepEqual(app.search("g", "hello"), ["g:r"], "control: allowed before the ceiling");
    const get = app.index.get.bind(app.index);
    app.index.get = (word: string) => {
      t += 8 * DAY; // the lookup is slow: it crosses the 7-day ceiling
      return get(word);
    };
    assert.equal(app.search("g", "hello"), null, "use that crossed the ceiling must not return hits");
  });

  it("acquireRecords: a reread 1 ms before its ceiling, plus a 2 ms write, is not kept", () => {
    let t = T0;
    const ceiling = 10 * DAY;
    const storage = new HookStorage();
    const app = new ToyApp();
    const c = new HeldDataClient({
      now: () => t, status: positive(() => t), store: app, storage, initialize: true,
      policy: { retentionCeilingMs: ceiling },
    });
    app.attach(c);
    app.sync("g", [{ id: "r", stream: "messages", text: "hello" }]);
    t = T0 + ceiling - 1;
    storage.afterWrite = () => { t += 2; };
    app.sync("g", [{ id: "r", stream: "messages", text: "hello again" }]);
    storage.afterWrite = null;
    assert.equal(app.holds("g").records, 0, "the write crossed the ceiling: nothing may be kept");
    assert.equal(app.search("g", "again"), null);
  });

  it("acquireRecords: a write that crosses the ceiling only for one record keeps the other", () => {
    let t = T0;
    const ceiling = 10 * DAY;
    const storage = new HookStorage();
    const app = new ToyApp();
    const c = new HeldDataClient({
      now: () => t, status: positive(() => t), store: app, storage, initialize: true,
      policy: { retentionCeilingMs: ceiling },
    });
    app.attach(c);
    app.sync("g", [{ id: "old", stream: "messages", text: "old" }]);
    t = T0 + ceiling - 1;
    storage.afterWrite = () => { t += 2; };
    const kept = c.acquireRecords("g", [
      { id: "old", stream: "messages" },
      { id: "fresh", stream: "messages" },
    ]);
    storage.afterWrite = null;
    assert.deepEqual(kept.map((x) => x.id), ["fresh"]);
  });

  it("acquire: a legacy reread 1 ms before the ceiling, plus a 2 ms write, is not kept", () => {
    let t = T0;
    const ceiling = 10 * DAY;
    const storage = new HookStorage();
    const app = new ToyApp();
    const c = new HeldDataClient({
      now: () => t, status: positive(() => t), store: app, storage, initialize: true,
      policy: { retentionCeilingMs: ceiling },
    });
    assert.equal(c.acquire("g"), true);
    app.records.set("g", [{ id: "r", stream: "messages", text: "x" }]);
    app.reindex("g");
    t = T0 + ceiling - 1;
    storage.afterWrite = () => { t += 2; };
    assert.equal(c.acquire("g"), false, "the write crossed the ceiling: the caller must not store the copy");
    storage.afterWrite = null;
    assert.equal(app.holds("g").records, 0);
  });

  const badSamples: [string, number][] = [["NaN", Number.NaN], ["backwards", T0 - 10 * DAY]];
  for (const [label, bad] of badSamples) {
    it(`acquireRecords: a ${label} sample after its write keeps nothing and disposes the copy`, async () => {
      let t = T0;
      const storage = new HookStorage();
      const app = new ToyApp();
      const c = new HeldDataClient({
        now: () => t, status: positive(() => T0), store: app, storage, initialize: true,
        policy: { retentionCeilingMs: 10 * DAY },
      });
      app.attach(c);
      app.sync("g", record);
      storage.afterWrite = () => { t = bad; };
      const kept = c.acquireRecords("g", [{ id: "n", stream: "messages" }]);
      assert.deepEqual(kept, []);
      assert.equal(app.holds("g").records, 0);
    });

    it(`acquire: a ${label} sample after its write refuses the copy and disposes it`, async () => {
      let t = T0;
      const storage = new HookStorage();
      const app = new ToyApp();
      const c = new HeldDataClient({
        now: () => t, status: positive(() => T0), store: app, storage, initialize: true,
        policy: { retentionCeilingMs: 10 * DAY },
      });
      assert.equal(c.acquire("g"), true);
      app.records.set("g", [{ id: "r", stream: "messages", text: "x" }]);
      app.reindex("g");
      app.attach(c);
      storage.afterWrite = () => { t = bad; };
      assert.equal(c.acquire("g"), false);
      assert.equal(app.holds("g").records, 0);
    });
  }
});
