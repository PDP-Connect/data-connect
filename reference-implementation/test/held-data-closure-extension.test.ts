// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Class: a positive assessment may extend a deadline only if, on a sample taken after any earlier
 * durable write, that deadline is still ahead. Core: "Clock rollback, restart, restored state, or an
 * uncertain mapping ... MUST NOT extend a deadline"; an answer that arrives after the long-stop is
 * disposed against the old assessment first.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToyApp } from "../examples/held-data-toy-app/app.ts";
import { HeldDataClient, type StatusTransport } from "../lib/held-data/client.ts";
import { DAY, T0 } from "./helpers/held-data-sim.ts";
import { HookStorage } from "./helpers/held-data-hook-storage.ts";

describe("an answer applied after a slow write cannot extend a deadline that write crossed", () => {
  it("batch reconcile: the second grant's long-stop passes during the first grant's write", async () => {
    let t = T0;
    const longStop = 10 * DAY;
    const storage = new HookStorage();
    const app = new ToyApp();
    const positive: StatusTransport = async (ids) => ({
      ok: true,
      results: ids.map((grant_id) => ({
        as_position: 1, assessed_at: t, ending: null, erasures: [], expires_at: null, grant_id,
        grant_state: "active" as const, ordinary_use: "permitted" as const,
      })),
    });
    const c = new HeldDataClient({
      now: () => t, status: positive, store: app, storage, initialize: true, batch: true,
      policy: { longStopMs: longStop },
    });
    app.attach(c);
    app.sync("a", [{ id: "r", stream: "messages", text: "alpha" }]);
    app.sync("b", [{ id: "r", stream: "messages", text: "bravo" }]);
    t = T0 + longStop - 1;
    storage.afterWrite = () => {
      t += 2; // the write after grant a's answer crosses grant b's long-stop
      storage.afterWrite = null;
    };
    await c.reconcile();
    assert.equal(app.holds("b").records, 0, "b's long-stop passed before its answer was applied");
    assert.equal(c.canUse("b").ok, false);
  });
});
