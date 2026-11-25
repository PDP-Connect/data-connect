// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { emitToStdout } from "../../packages/connector-protocol/src/safe-emit.ts";

test("a synchronous JSONL write failure rejects with the sink error and removes listeners", async () => {
  const sink = new Writable();
  const failure = new Error("synthetic synchronous sink failure");
  Object.defineProperty(sink, "write", {
    value: () => {
      throw failure;
    },
  });

  await assert.rejects(emitToStdout({ type: "fixture" }, sink), (error) => error === failure);
  assert.equal(sink.listenerCount("error"), 0);
  assert.equal(sink.listenerCount("close"), 0);
});

test("a sink error wins while a JSONL write callback is still pending", async () => {
  const sink = new Writable();
  const callbacks: (() => void)[] = [];
  Object.defineProperty(sink, "write", {
    value: (_line: string, complete: () => void) => {
      callbacks.push(complete);
      return true;
    },
  });
  const failure = new Error("synthetic sink error before write completion");
  const rejected = assert.rejects(emitToStdout({ type: "fixture" }, sink), (error) => error === failure);

  assert.equal(callbacks.length, 1);
  sink.emit("error", failure);
  await rejected;
  for (const complete of callbacks) {
    complete();
  }
  assert.equal(sink.listenerCount("error"), 0);
  assert.equal(sink.listenerCount("close"), 0);
});
