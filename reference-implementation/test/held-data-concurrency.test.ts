// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { on, once } from "node:events";
import { mkdirSync, readFileSync, rmdirSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { Worker } from "node:worker_threads";
import { appendJournalEntry, readLossEvidence } from "../lib/authority-journal/journal.ts";
import { HeldDataAuthority } from "../lib/held-data/authority.ts";
import { tempDir } from "./helpers/held-data-sim.ts";

it("concurrent terminal and non-terminal writers preserve the journal, evidence and status after acknowledgement", async (t) => {
  const dir = tempDir("held-concurrent-");
  const journalPath = join(dir, "journal");
  const epochMarkerPath = join(dir, "evidence");
  const authority = HeldDataAuthority.open({ epochMarkerPath, journalPath, now: () => 1000 });
  authority.registerGrant({
    clientId: "app",
    confidential: false,
    expiresAtMs: null,
    grantId: "g",
    streams: ["s"],
    subjectId: "owner",
  });
  authority.recordCredential({ grantIds: ["g"], kind: "access", token: "test-token" });
  const before = statSync(journalPath).size;
  const gate = new SharedArrayBuffer(4);
  const count = 100;
  const workers = Array.from(
    { length: 3 },
    (_, worker) =>
      new Worker(new URL("./helpers/held-data-journal-worker.ts", import.meta.url), {
        execArgv: ["--import", "tsx"],
        workerData: { count, epochMarkerPath, gate, journalPath, worker },
      })
  );
  t.after(async () => {
    await Promise.all(workers.map((w) => w.terminate()));
  });
  await Promise.all(workers.map((w) => once(w, "message")));
  const acknowledged = workers.map((w) => once(w, "message"));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  // Yield scheduling while threads append; protocol time stays injected.
  let finished = false;
  let failure: unknown;
  const all = Promise.all(acknowledged)
    .catch((error) => {
      failure = error;
    })
    .finally(() => {
      finished = true;
    });
  let reads = 0;
  while (!finished) {
    const principal = authority.authenticateRead({ token: "test-token" });
    assert.ok(principal);
    authority.status(principal, ["g"]);
    assert.equal(authority.lost, false, "a healthy journal must never look lost");
    reads += 1;
    // biome-ignore lint/performance/noAwaitInLoops: sample status while the writers run.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await all;
  if (failure) {
    throw failure;
  }
  assert.ok(reads > 0);
  const replies = workers.map((w) => once(w, "message"));
  for (const worker of workers) {
    worker.postMessage("status");
  }
  for (const [result] of await Promise.all(replies)) {
    assert.equal(result.lost, false);
    assert.equal(result.answer.ordinary_use, "stopped", "every process sees acknowledged erasure");
  }
  const lines = readFileSync(journalPath, "utf8").trim().split("\n");
  const entries = lines.map((line) => JSON.parse(line));
  for (let worker = 0; worker < workers.length; worker += 1) {
    for (let i = 0; i < count; i += 1) {
      assert.equal(entries.filter((e) => e.id === `${worker}-${i}`).length, 1, "no lost or interleaved entry");
    }
  }
  const terminal = new Set(["hd_keep", "erase"]);
  let bytes = 0;
  let lastTerminal = 0;
  for (let i = 0; i < lines.length; i += 1) {
    bytes += Buffer.byteLength(`${lines[i]}\n`);
    if (terminal.has(entries[i].t)) {
      lastTerminal = bytes;
    }
  }
  const evidence = readLossEvidence(epochMarkerPath);
  assert.ok(evidence);
  assert.ok(evidence.bytes >= lastTerminal, "evidence covers every acknowledged terminal entry");
  assert.ok(evidence.bytes <= bytes, "evidence does not outrun the journal");
  truncateSync(journalPath, before);
  assert.equal(authority.lost, true, "a live process detects loss");
  assert.equal(
    HeldDataAuthority.open({ epochMarkerPath, journalPath, now: () => 1000 }).lost,
    true,
    "a new process detects loss"
  );
});

for (const scenario of ["startup", "erase", "status"] as const) {
  it(`orders concurrent ${scenario} decisions with terminal acknowledgements`, async (t) => {
    const dir = tempDir("held-ordered-");
    const journalPath = join(dir, "journal");
    const epochMarkerPath = join(dir, "evidence");
    if (scenario !== "startup") {
      const as = HeldDataAuthority.open({ epochMarkerPath, journalPath, now: () => 1000 });
      as.registerGrant({
        clientId: "app",
        confidential: false,
        expiresAtMs: null,
        grantId: "g",
        streams: [],
        subjectId: "owner",
      });
      as.recordCredential({ grantIds: ["g"], kind: "access", token: "test-token" });
    }
    const gate = new SharedArrayBuffer(4);
    const workers = [true, false].map(
      (paused) =>
        new Worker(new URL("./helpers/held-data-ordering-worker.ts", import.meta.url), {
          execArgv: ["--import", "tsx"],
          workerData: { epochMarkerPath, gate, journalPath, paused, scenario },
        })
    );
    t.after(async () => {
      await Promise.all(workers.map((w) => w.terminate()));
    });
    const messages = workers.map((w) => {
      const incoming = on(w, "message");
      return async (): Promise<{ type: string; result: Record<string, unknown> }> => {
        const { value } = await incoming.next();
        assert.ok(value);
        return value[0];
      };
    });
    const [firstWorker, secondWorker] = workers;
    const [firstMessage, secondMessage] = messages;
    assert.ok(firstWorker && secondWorker && firstMessage && secondMessage);
    await Promise.all(messages.map((next) => next()));
    firstWorker.postMessage("run");
    assert.equal((await firstMessage()).type, "checkpoint");
    secondWorker.postMessage("run");
    const concurrent = await secondMessage();
    assert.ok(["contended", "done"].includes(concurrent.type));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const first = await firstMessage();
    const second = concurrent.type === "done" ? concurrent : await secondMessage();
    assert.equal(first.type, "done");
    assert.equal(second.type, "done");
    if (scenario === "startup") {
      assert.equal(first.result.lost, false);
      assert.equal(second.result.lost, false);
      const epochs = readFileSync(journalPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((e) => e.t === "hd_epoch");
      assert.equal(epochs.length, 1, "one initialization, including its evidence, across processes");
    } else if (scenario === "erase") {
      assert.deepEqual(first.result, second.result, "concurrent retries return the same instruction and clock");
    } else if (concurrent.type === "done") {
      assert.equal(
        first.result.ordinary_use,
        "stopped",
        "no positive computation after another process acknowledged erasure"
      );
    } else {
      assert.equal(
        first.result.ordinary_use,
        "permitted",
        "assessment computed before the terminal writer acquired the lock"
      );
      const as = HeldDataAuthority.open({ epochMarkerPath, journalPath, now: () => 1000 });
      const principal = as.authenticateRead({ token: "test-token" });
      assert.ok(principal);
      const [answer] = as.status(principal, ["g"]);
      assert.ok(answer && "ordinary_use" in answer);
      assert.equal(answer.ordinary_use, "stopped");
    }
  });
}

it("a stale lock refuses held-data writes until explicit recovery; unregistered flag-off appends stay unchanged", (t) => {
  const dir = tempDir("held-stale-lock-");
  const journalPath = join(dir, "journal");
  const epochMarkerPath = join(dir, "evidence");
  const as = HeldDataAuthority.open({ epochMarkerPath, journalPath, now: () => 1000 });
  as.registerGrant({
    clientId: "app",
    confidential: false,
    expiresAtMs: null,
    grantId: "g",
    streams: [],
    subjectId: "owner",
  });
  mkdirSync(`${journalPath}.lock`);
  let elapsed = 0;
  const clock = t.mock.method(performance, "now", () => {
    elapsed += 30_001;
    return elapsed;
  });
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion.
  assert.throws(() => as.requestErasure({ grantId: "g", origin: "owner" }), /lock unavailable/);
  clock.mock.restore();
  rmdirSync(`${journalPath}.lock`);
  assert.ok(as.requestErasure({ grantId: "g", origin: "owner" }).operationId);
  const legacy = join(dir, "lease-only");
  mkdirSync(`${legacy}.lock`);
  appendJournalEntry(legacy, { grant_id: "g", id: "legacy", t: "tombstone" });
  assert.equal(JSON.parse(readFileSync(legacy, "utf8")).id, "legacy");
});
