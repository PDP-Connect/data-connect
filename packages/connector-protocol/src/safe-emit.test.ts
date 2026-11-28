// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { emitToStdout } from "./safe-emit.ts";

function heldSink(accepted: boolean) {
  const sink = new Writable();
  const lines: string[] = [];
  let complete!: (error?: Error | null) => void;
  Object.defineProperty(sink, "write", {
    value: (line: string, callback: typeof complete) => {
      lines.push(line);
      complete = callback;
      return accepted;
    },
  });
  return { complete: (error?: Error) => complete(error), lines, sink };
}

test("JSONL rejects when an accepted write later fails its callback", async () => {
  const fake = heldSink(true);
  const error = new Error("fixture write failed");
  const pending = assert.rejects(emitToStdout({ type: "fixture" }, fake.sink), (actual) => actual === error);
  fake.complete(error);
  // Writable may emit the same error after reporting it to the write callback.
  fake.sink.emit("error", error);
  await pending;
  assert.equal(fake.sink.listenerCount("error"), 0);
  assert.equal(fake.sink.listenerCount("close"), 0);
});

test("JSONL rejects on close before completion without waiting for drain", async () => {
  const fake = heldSink(false);
  const pending = assert.rejects(emitToStdout({ type: "fixture" }, fake.sink), /closed before JSONL write completed/);
  fake.sink.emit("close");
  await pending;
  assert.equal(fake.sink.listenerCount("error"), 0);
  assert.equal(fake.sink.listenerCount("close"), 0);
});

for (const accepted of [true, false]) {
  test(`JSONL succeeds only after the complete line's callback (write returned ${accepted})`, async () => {
    const fake = heldSink(accepted);
    let resolved = false;
    const pending = emitToStdout({ type: "fixture" }, fake.sink).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.deepEqual(fake.lines, ['{"type":"fixture"}\n']);
    fake.complete();
    await pending;
    assert.equal(fake.sink.listenerCount("error"), 0);
    assert.equal(fake.sink.listenerCount("close"), 0);
  });
}
