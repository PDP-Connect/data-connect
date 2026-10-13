// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToyApp } from "../examples/held-data-toy-app/app.ts";
import { HeldDataClient } from "../lib/held-data/client.ts";
import { HeldDataAuthority } from "../lib/held-data/authority.ts";
import { DAY, HOUR, T0, tempDir } from "./helpers/held-data-sim.ts";

function fixture(expiresAt: number | null = T0 + DAY) {
  let t = T0;
  const journalPath = join(tempDir("held-features-"), "authority.journal");
  const as = HeldDataAuthority.open({ journalPath, now: () => t });
  as.registerGrant({
    grantId: "g",
    clientId: "app",
    subjectId: "owner",
    confidential: false,
    streams: ["messages"],
    expiresAtMs: expiresAt,
  });
  as.recordCredential({ token: "historical", grantIds: ["g"], kind: "access" });
  const ask = () => {
    const principal = as.authenticateRead({ token: "historical" });
    assert.ok(principal);
    const [answer] = as.status(principal, ["g"]);
    assert.ok(answer && !("error" in answer));
    return answer;
  };
  return {
    as,
    ask,
    journalPath,
    now: () => t,
    at: (at: number) => {
      t = at;
    },
  };
}

describe("lane F: P6 advance deletion elections", () => {
  it("keeps use permitted before expiry and activates the same durable instruction at expires_at", () => {
    const f = fixture();
    const election = f.as.electAdvance("g");
    assert.equal(f.ask().ordinary_use, "permitted");
    assert.deepEqual(f.ask().erasures, []);
    assert.equal(f.as.hasEnded("g"), false);
    f.at(T0 + DAY);
    const answer = f.ask();
    assert.equal(answer.grant_state, "expired");
    assert.equal(answer.ordinary_use, "stopped");
    assert.equal(answer.erasures[0]?.operation_id, election.operationId);
    assert.equal(answer.erasures[0]?.accepted_at, T0);
    assert.equal(answer.erasures[0]?.effective_at, T0 + DAY);
    assert.deepEqual(f.as.electAdvance("g"), election);
    const restored = HeldDataAuthority.open({ journalPath: f.journalPath, now: f.now });
    const principal = restored.authenticateRead({ token: "historical" });
    assert.ok(principal);
    const [a] = restored.status(principal, ["g"]);
    assert.ok(a && !("error" in a));
    assert.equal(a.erasures[0]?.operation_id, election.operationId);
    f.as.elect({ grantId: "g", disposition: "keep" });
    assert.equal(f.ask().ordinary_use, "stopped");
  });

  it("an immediate erase accelerates an advance election without changing acceptance or its identifier", () => {
    const f = fixture();
    const election = f.as.electAdvance("g");
    f.at(T0 + HOUR);
    const immediate = f.as.requestErasure({ grantId: "g", origin: "owner_election" });
    assert.deepEqual(immediate, election);
    const a = f.ask();
    assert.equal(a.grant_state, "ended");
    assert.equal(a.ending?.ended_at, T0 + HOUR);
    assert.equal(a.erasures[0]?.accepted_at, T0);
    assert.equal(a.erasures[0]?.effective_at, T0 + HOUR);
    f.at(T0 + DAY);
    assert.deepEqual(f.as.requestErasure({ grantId: "g", origin: "retry" }), election);
    assert.equal(f.ask().erasures[0]?.effective_at, T0 + HOUR);
  });

  it("an election on a grant without expiry waits for its actual ending", () => {
    const f = fixture(null);
    const election = f.as.electAdvance("g");
    f.at(T0 + 365 * DAY);
    assert.equal(f.ask().ordinary_use, "permitted");
    f.as.end({ grantId: "g", path: "owner_withdrawal", disposition: "keep" });
    const a = f.ask();
    assert.equal(a.ordinary_use, "stopped");
    assert.equal(a.erasures[0]?.operation_id, election.operationId);
    assert.equal(a.erasures[0]?.effective_at, T0 + 365 * DAY);
  });
});

describe("lane F: per-record retention ceilings", () => {
  function setup() {
    let t = T0;
    const app = new ToyApp();
    const client = new HeldDataClient({
      now: () => t,
      store: app,
      status: async () => ({ ok: false, reason: "offline" }),
      policy: { retentionCeilingMs: 2 * DAY },
    });
    app.attach(client);
    return {
      app,
      client,
      at: (at: number) => {
        t = at;
      },
    };
  }

  it("deletes each record at its own ceiling and regenerates a mixed derivative without the expired record", async () => {
    const s = setup();
    s.app.sync("g", [{ id: "old", stream: "messages", text: "oldword" }]);
    s.at(T0 + DAY);
    s.app.sync("g", [{ id: "new", stream: "messages", text: "newword" }]);
    s.app.reindex("g");
    s.at(T0 + 2 * DAY);
    await s.client.tick();
    assert.deepEqual(
      s.app.records.get("g")?.map((r) => r.id),
      ["new"],
    );
    assert.equal(s.app.index.get("oldword")?.size ?? 0, 0);
    assert.equal(s.app.summaries.get("g"), "1 records");
    assert.equal(s.client.deleteBy("g"), T0 + 3 * DAY);
    s.at(T0 + 3 * DAY);
    await s.client.tick();
    assert.equal(s.app.holds("g").records, 0);
    assert.equal(s.app.holds("g").summary, false);
  });

  it("rereads and a later grant never restart a known version's ceiling", async () => {
    const s = setup();
    const r = { id: "r", stream: "messages", text: "same", version: "v1" };
    s.app.sync("g", [r]);
    s.at(T0 + DAY);
    s.app.sync("g", [r]);
    s.app.sync("g2", [r]);
    s.at(T0 + 2 * DAY);
    await s.client.tick();
    assert.equal(s.app.holds("g").records, 0);
    assert.equal(s.app.holds("g2").records, 0);
    s.app.sync("g3", [r]);
    assert.equal(s.app.holds("g3").records, 0);
  });

  it("deletes expired word-index keys while preserving words still held by another grant", async () => {
    const s = setup();
    s.app.sync("g", [{ id: "old", stream: "messages", text: "expiredword shared" }]);
    s.at(T0 + DAY);
    s.app.sync("g2", [{ id: "new", stream: "messages", text: "liveword shared" }]);
    s.at(T0 + 2 * DAY);
    await s.client.tick();
    assert.equal(s.app.index.has("expiredword"), false);
    assert.deepEqual([...(s.app.index.get("shared") ?? [])], ["g2:new"]);
    assert.equal(s.app.index.has("liveword"), true);
    s.at(T0 + 3 * DAY);
    await s.client.tick();
    assert.equal(s.app.index.size, 0);
  });

  it("a later identifiable version gets its own receipt clock, while ambiguous versions use the earliest acquisition", async () => {
    const s = setup();
    s.app.sync("g", [{ id: "r", stream: "messages", text: "v1", version: "v1" }]);
    s.at(T0 + DAY);
    s.app.sync("g", [{ id: "r", stream: "messages", text: "v2", version: "v2" }]);
    s.app.sync("ambiguous", [{ id: "r", stream: "messages", text: "unknown" }]);
    s.at(T0 + 2 * DAY);
    await s.client.tick();
    assert.equal(s.app.records.get("g")?.[0]?.text, "v2");
    assert.equal(s.app.holds("ambiguous").records, 0);
    s.at(T0 + 3 * DAY);
    await s.client.tick();
    assert.equal(s.app.holds("g").records, 0);
  });
});

describe("lane F: read-state precedence", () => {
  it("never reopens a single-use window and gives expiry and revocation precedence", () => {
    const f = fixture(T0 + DAY);
    f.as.recordReadWindow("g", T0 + HOUR);
    f.as.recordReadWindow("g", T0 + 2 * HOUR);
    f.at(T0 + HOUR);
    assert.equal(f.ask().grant_state, "window_closed");
    assert.equal(f.ask().ordinary_use, "permitted");
    f.at(T0 + DAY);
    assert.equal(f.ask().grant_state, "expired");
    f.as.end({ grantId: "g", path: "owner_withdrawal", disposition: "keep" });
    assert.equal(f.ask().grant_state, "ended");
    assert.equal(f.ask().ordinary_use, "permitted");
  });
});
