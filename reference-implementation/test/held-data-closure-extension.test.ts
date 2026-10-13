// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Class: an answer may license data only if, on a sample taken after any earlier durable write, the
 * data's retention ceiling is still ahead. Core: "Clock rollback, restart, restored state, or an
 * uncertain mapping ... MUST NOT extend a deadline"; data past its ceiling is disposed before an
 * answer that arrives after it is applied. (An answer extends no deadline in v0.1.0: this guards
 * the licence, not a clock.)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToyApp } from "../examples/held-data-toy-app/app.ts";
import { HeldDataClient, type StatusTransport } from "../lib/held-data/client.ts";
import { DAY, T0 } from "./helpers/held-data-sim.ts";
import { HookStorage } from "./helpers/held-data-hook-storage.ts";

describe("an answer applied after a slow write cannot license data whose ceiling that write crossed", () => {
  it("batch reconcile: the second grant's retention ceiling passes during the first grant's write", async () => {
    let t = T0;
    const ceiling = 10 * DAY;
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
      policy: { retentionCeilingMs: ceiling },
    });
    app.attach(c);
    app.sync("a", [{ id: "r", stream: "messages", text: "alpha" }]);
    app.sync("b", [{ id: "r", stream: "messages", text: "bravo" }]);
    t = T0 + ceiling - 1;
    storage.afterWrite = () => {
      t += 2; // the write after grant a's answer crosses grant b's ceiling
      storage.afterWrite = null;
    };
    await c.reconcile();
    assert.equal(app.holds("b").records, 0, "b's ceiling passed before its answer was applied");
    assert.equal(c.canUse("b").ok, false);
  });
});
