// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Class: a clock sample that is non-finite, backwards or shows a suspend cannot show that a deadline
 * remains in the future. Core: "If it cannot establish that a disposal deadline remains in the
 * future, it MUST treat disposal as due." Refusing is not enough; the held copy must be disposed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToyApp } from "../examples/held-data-toy-app/app.ts";
import { HeldDataClient, type StatusTransport } from "../lib/held-data/client.ts";
import { DAY, T0 } from "./helpers/held-data-sim.ts";
import { HookStorage } from "./helpers/held-data-hook-storage.ts";

const record = [{ id: "r", stream: "messages", text: "hello world" }];
const positive = (now: () => number): StatusTransport => async (ids) => ({
  ok: true,
  results: ids.map((grant_id) => ({
    as_position: 1, assessed_at: now(), ending: null, erasures: [], expires_at: null, grant_id,
    grant_state: "active" as const, ordinary_use: "permitted" as const,
  })),
});

const badSamples: [string, number][] = [["NaN", Number.NaN], ["backwards", T0 - 10 * DAY]];

describe("a bad clock sample after a durable write makes disposal due", () => {
  for (const [label, bad] of badSamples) {
    it(`canUse: a ${label} final sample disposes the copy, not just refuses`, async () => {
      let t = T0;
      const storage = new HookStorage();
      const app = new ToyApp();
      const c = new HeldDataClient({ now: () => t, status: positive(() => T0), store: app, storage, initialize: true });
      app.attach(c);
      app.sync("g", record);
      await c.reconcile();
      assert.equal(app.holds("g").records, 1);
      // The first write inside the gate is followed by no clock read until the final sample.
      storage.afterWrite = () => { t = bad; };
      assert.equal(c.canUse("g").ok, false);
      assert.equal(app.holds("g").records, 0, "disposal is due when a deadline cannot be shown to remain ahead");
    });
  }
});
