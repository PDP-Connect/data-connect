// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import accountingReporter from "./node-reporter.ts";
import { lastStartedTestName, PROGRESS_EVENT_LINE, withoutProgressEvents } from "./receipt.ts";

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
  // The output only shows as one content-free progress event (at most one a second).
  assert.deepEqual(lines, [
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:running","details":{"name":"hangs"}}\n',
    `${PROGRESS_EVENT_LINE}\n`,
  ]);
});

for (const type of ["test:stdout", "test:stderr", "test:diagnostic"]) {
  test(`${type} output is shown to the watchdog as a content-free progress event`, async () => {
    const lines = await collect([{ data: { message: "SYNTHETIC-PROGRESS-SECRET\n" }, type }]);
    assert.deepEqual(lines, [`${PROGRESS_EVENT_LINE}\n`]);
    assert.equal(PROGRESS_EVENT_LINE, 'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:progress"}');
  });
}

test("a file that exits on its own prints no progress or running events", () => {
  const output = [
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:running","details":{"name":"a"}}',
    PROGRESS_EVENT_LINE,
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test","name":"a"}}',
    "",
  ].join("\n");
  assert.equal(
    withoutProgressEvents(output),
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test","name":"a"}}\n'
  );
});

test("a forged running event is cut to 200 characters when read", () => {
  const forged = `PDPP_TEST_ACCOUNTING_EVENT {"type":"test:running","details":{"name":"${"f".repeat(5000)}"}}\n`;
  assert.equal(lastStartedTestName(forged)?.length, 200);
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
