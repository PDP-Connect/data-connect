// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { on } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { Worker } from "node:worker_threads";
import { HeldDataAuthority } from "../lib/held-data/authority.ts";
import { tempDir } from "./helpers/held-data-sim.ts";

it("D4 recovery and a concurrent erasure retry converge to one instruction", async (t) => {
  const dir = tempDir("held-integration-");
  const opts = {
    epochMarkerPath: join(dir, "evidence"),
    journalPath: join(dir, "journal"),
    pendingEvidencePath: join(dir, "pending-evidence"),
    pendingPath: join(dir, "pending"),
  };
  const grant = {
    clientId: "app",
    confidential: false,
    expiresAtMs: null,
    grantId: "g",
    streams: [],
    subjectId: "owner",
  };
  const authority = HeldDataAuthority.open({ ...opts, now: () => 1000 });
  authority.registerGrant(grant);
  const history = readFileSync(opts.journalPath);
  rmSync(opts.journalPath);
  const pending = authority.end({ disposition: "delete", grant, grantId: "g", path: "owner_withdrawal" });
  assert.equal(pending.pending, true);
  writeFileSync(opts.journalPath, history);
  const gate = new SharedArrayBuffer(4);
  const workers = [true, false].map(
    (recovering) =>
      new Worker(new URL("./helpers/held-data-recovery-worker.ts", import.meta.url), {
        execArgv: ["--import", "tsx"],
        workerData: {
          gate,
          opts,
          recovering,
        },
      })
  );
  t.after(async () => {
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    await Promise.all(workers.map((worker) => worker.terminate()));
  });
  const messages = workers.map((worker) => {
    const incoming = on(worker, "message");
    return async (): Promise<{ type: string }> => {
      const { value } = await incoming.next();
      assert.ok(value);
      return value[0];
    };
  });
  const [recoverer, retry] = workers;
  const [recoveryMessage, retryMessage] = messages;
  assert.ok(recoverer && retry && recoveryMessage && retryMessage);
  const ready = await Promise.all(messages.map((next) => next()));
  assert.deepEqual(ready.map((message) => message.type), ["ready", "ready"]);
  recoverer.postMessage("run");
  assert.equal((await recoveryMessage()).type, "checkpoint");
  retry.postMessage("run");
  const concurrent = await retryMessage();
  assert.ok(["done", "contended"].includes(concurrent.type));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  assert.equal((await recoveryMessage()).type, "done");
  if (concurrent.type === "contended") {
    assert.equal((await retryMessage()).type, "done");
  }
  const recovered = HeldDataAuthority.open({ ...opts, now: () => 1000 });
  assert.equal(recovered.lost, false);
  const erasures = recovered.ownerView("g", 1000)?.erasures;
  assert.equal(erasures?.length, 1, "replay and retry must not issue competing erasure IDs");
  assert.equal(erasures[0]?.operation_id, pending.erasure?.operationId);
  assert.deepEqual(recovered.pendingActions(), []);
  const entries = readFileSync(opts.journalPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(entries.filter((entry) => entry.t === "tombstone").length, 1);
});
