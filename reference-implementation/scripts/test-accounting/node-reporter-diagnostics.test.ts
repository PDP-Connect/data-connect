// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import accountingReporter from "./node-reporter.ts";
import { DIAGNOSTIC_PREFIX } from "./receipt.ts";

type Step = { delayMs?: number; event: { data?: Record<string, unknown>; type: string } };

async function collect(steps: Step[]): Promise<string[]> {
  async function* source() {
    for (const { delayMs, event } of steps) {
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      yield event;
    }
  }
  const lines: string[] = [];
  for await (const line of accountingReporter(source())) {
    lines.push(line);
  }
  return lines;
}

function diagnosticText(lines: string[]): string {
  return lines
    .filter((line) => line.startsWith(DIAGNOSTIC_PREFIX))
    .map((line) => JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length)) as string)
    .join("");
}

test("output of a test that never finishes is flushed as a redacted diagnostic when the stream goes quiet", async () => {
  const lines = await collect([
    { event: { data: { message: "HUNG-MARKER Authorization: Bearer SYNTHETIC-SECRET\n" }, type: "test:stderr" } },
    { event: { data: { message: "stdout-marker\n" }, type: "test:stdout" } },
    // The stream stays quiet long enough for the idle flush, then ends.
    { delayMs: 600, event: { type: "test:complete" } },
  ]);
  const text = diagnosticText(lines);
  assert.match(text, /HUNG-MARKER/);
  assert.match(text, /stdout-marker/);
  assert.doesNotMatch(text, /SYNTHETIC-SECRET/);
});

test("diagnostics come before the terminal event they precede", async () => {
  const lines = await collect([
    { event: { data: { message: "noise-before-pass\n" }, type: "test:stderr" } },
    { event: { data: { details: { type: "test" }, name: "t" }, type: "test:pass" } },
  ]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]?.startsWith(DIAGNOSTIC_PREFIX));
  assert.match(lines[0] ?? "", /noise-before-pass/);
  assert.match(lines[1] ?? "", /^PDPP_TEST_ACCOUNTING_EVENT /);
});

test("a stream with no test output emits only accounting events", async () => {
  const lines = await collect([{ event: { data: { details: { type: "test" }, name: "t" }, type: "test:pass" } }]);
  assert.equal(lines.length, 1);
  assert.ok(lines.every((line) => !line.startsWith(DIAGNOSTIC_PREFIX)));
});

test("a pause never flushes a partial line", async () => {
  const lines = await collect([
    { event: { data: { message: "complete-line\nPARTIAL-LINE-NO-NEWLINE" }, type: "test:stderr" } },
    // The stream goes quiet, so the idle flush runs; the stream then ends.
    { delayMs: 600, event: { type: "test:complete" } },
  ]);
  const text = diagnosticText(lines);
  assert.match(text, /complete-line/);
  assert.doesNotMatch(text, /PARTIAL-LINE-NO-NEWLINE/);
});

test("a header split across a pause never leaks its value", async () => {
  const lines = await collect([
    { event: { data: { message: "HUNG-MARKER\nAuthorization: Bearer\n" }, type: "test:stderr" } },
    { delayMs: 700, event: { data: { message: "SYNTHETIC-HUNG-SECRET\n" }, type: "test:stderr" } },
    { delayMs: 600, event: { type: "test:complete" } },
  ]);
  const text = diagnosticText(lines);
  assert.match(text, /HUNG-MARKER/);
  assert.doesNotMatch(text, /SYNTHETIC-HUNG-SECRET/);
});

test("a credential region ends at a blank line and the output after it is kept", async () => {
  const lines = await collect([
    {
      event: {
        data: { message: "Authorization: Bearer\nSYNTHETIC-DROPPED-SECRET\n\nafter-blank\n" },
        type: "test:stderr",
      },
    },
    { delayMs: 600, event: { type: "test:complete" } },
  ]);
  const text = diagnosticText(lines);
  assert.match(text, /possible credential continuation/);
  assert.match(text, /after-blank/);
  assert.doesNotMatch(text, /SYNTHETIC-DROPPED-SECRET/);
});

test("a line over 2 KB is truncated and marked", async () => {
  const lines = await collect([
    { event: { data: { message: `${"y".repeat(5000)}\n` }, type: "test:stderr" } },
    { delayMs: 600, event: { type: "test:complete" } },
  ]);
  const text = diagnosticText(lines);
  assert.match(text, /y{100}…\[line truncated\]/);
  assert.doesNotMatch(text, /y{2049}/);
});
