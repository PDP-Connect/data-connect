// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import accountingReporter from "./node-reporter.ts";
import { lastStartedTestName } from "./receipt.ts";

async function collect(events: { data?: Record<string, unknown>; type: string }[]): Promise<string[]> {
  async function* source() {
    yield* events;
  }
  const lines: string[] = [];
  for await (const line of accountingReporter(source())) {
    lines.push(line);
  }
  return lines;
}

test("a running test is announced by name, and test output is never emitted", async () => {
  const lines = await collect([
    { data: { name: "hangs" }, type: "test:dequeue" },
    { data: { message: "Authorization: Bearer SYNTHETIC-SECRET\n" }, type: "test:stderr" },
    { data: { message: "stdout text\n" }, type: "test:stdout" },
    { data: { message: "a diagnostic\n" }, type: "test:diagnostic" },
  ]);
  assert.deepEqual(lines, ['PDPP_TEST_ACCOUNTING_EVENT {"type":"test:running","details":{"name":"hangs"}}\n']);
});

test("a started test name is cut to 200 characters", async () => {
  const [line] = await collect([{ data: { name: "n".repeat(500) }, type: "test:dequeue" }]);
  assert.equal(lastStartedTestName(line ?? "")?.length, 200);
});

test("the last started test is the last start event, read past passes and a cut-off line", () => {
  const output = [
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:running","details":{"name":"a"}}',
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:running","details":{"name":"b"}}',
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test","name":"b"}}',
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:running","details":{"na',
  ].join("\n");
  assert.equal(lastStartedTestName(output), "b");
  assert.equal(lastStartedTestName("no events here\n"), undefined);
});
