// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunRecordRejectionReceipts } from "../../lib/ref-client.ts";
import type { RunRejectionSummary } from "../../lib/run-rejections.ts";
import { RejectedRecordsSection } from "./rejected-records-section.tsx";

const receipt = {
  firstInputIndex: 4,
  payloadBytes: 120,
  reasonCode: "schema_violation",
  receiptId: "r1",
  stream: "messages",
};

const none: RunRejectionSummary = { rejected: { count: 0, kind: "final" }, unaccounted: [], unaccountedComplete: true };

function render(summary: RunRejectionSummary, receipts: RunRecordRejectionReceipts | null = null): string {
  return renderToStaticMarkup(createElement(RejectedRecordsSection, { receipts, summary }));
}

test("the run page shows the rejected-record count and each receipt's stream and reason", () => {
  const html = render(
    { ...none, rejected: { count: 2, kind: "final" } },
    { receipts: [receipt, { ...receipt, receiptId: "r2", stream: "threads" }], truncated: false },
  );
  assert.match(html, /Rejected records/);
  assert.match(html, /permanently rejected 2 records/);
  assert.match(html, /<code>messages<\/code>/);
  assert.match(html, /<code>threads<\/code>/);
  assert.match(html, /<code>schema violation<\/code>/);
  assert.doesNotMatch(html, /Unaccounted records/);
  assert.doesNotMatch(html, /receipt list is partial/);
});

test("the run page shows the unaccounted count per stream", () => {
  const html = render({ ...none, unaccounted: [{ stream: "bodies", unaccounted: 3 }] });
  assert.match(html, /Unaccounted records/);
  assert.match(html, /<code>bodies<\/code>/);
  assert.match(html, /3 unaccounted records/);
  assert.doesNotMatch(html, /Rejected records/);
});

test("the section does not claim the other records were stored", () => {
  const html = render({
    ...none,
    rejected: { count: 1, kind: "final" },
    unaccounted: [{ stream: "bodies", unaccounted: 3 }],
  });
  assert.doesNotMatch(html, /other records/);
});

test("a count that is only a lower bound says so", () => {
  const html = render({ ...none, rejected: { count: 3, kind: "at_least" }, unaccountedComplete: false });
  assert.match(html, /at least 3 records/);
  assert.match(html, /covers only the events loaded on this page/);
});

test("a count of a run still in progress says so", () => {
  const html = render({ ...none, rejected: { count: 1, kind: "so_far" } });
  assert.match(html, /permanently rejected 1 record so far/);
  assert.match(html, /still in progress/);
});

test("an unreadable count renders as unavailable, never as nothing", () => {
  const html = render({ ...none, rejected: { kind: "unknown" } });
  assert.match(html, /Rejected records/);
  assert.match(html, /count is not available here/);
  assert.doesNotMatch(html, /receipt list is unavailable/);
});

test("unaccounted streams on other timeline pages are flagged as not listed", () => {
  const html = render({ ...none, unaccountedComplete: false });
  assert.match(html, /Unaccounted records/);
  assert.match(html, /No unaccounted records are listed/);
  assert.match(html, /streams reported on other pages are not listed/);
  assert.doesNotMatch(html, /<ul/);
});

test("the rejected count renders with an unavailable note when the receipt list could not be read", () => {
  const html = render({ ...none, rejected: { count: 1, kind: "final" } });
  assert.match(html, /permanently rejected 1 record in this run/);
  assert.match(html, /receipt list is unavailable/);
  assert.doesNotMatch(html, /<ul/);
});

test("a receipt list cut short by the page cap says it is partial", () => {
  const html = render({ ...none, rejected: { count: 9, kind: "final" } }, { receipts: [receipt], truncated: true });
  assert.match(html, /receipt list is partial: 1 receipt found, and more may exist/);
});

test("a run with a known zero rejected and every timeline page loaded renders no section", () => {
  assert.equal(render(none, { receipts: [], truncated: false }), "");
});
