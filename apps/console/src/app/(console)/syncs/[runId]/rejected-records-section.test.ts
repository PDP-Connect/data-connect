// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RecordRejectionReceiptPage, RunRecordOutcomes } from "../../lib/ref-client.ts";
import { RejectedRecordsSection } from "./rejected-records-section.tsx";

const receipt = {
  firstInputIndex: 4,
  payloadBytes: 120,
  reasonCode: "schema_violation",
  receiptId: "r1",
  stream: "messages",
};

const clean: RunRecordOutcomes = { permanently_rejected: 0, unaccounted_by_stream: {} };

function render({
  moreReceiptsHref = null,
  outcomes,
  receipts = null,
}: {
  moreReceiptsHref?: string | null;
  outcomes: RunRecordOutcomes | null;
  receipts?: RecordRejectionReceiptPage | null;
}): string {
  return renderToStaticMarkup(createElement(RejectedRecordsSection, { moreReceiptsHref, outcomes, receipts }));
}

test("shows the server's rejected total and each receipt's stream and reason", () => {
  const html = render({
    outcomes: { ...clean, permanently_rejected: 2 },
    receipts: { nextCursor: null, receipts: [receipt, { ...receipt, receiptId: "r2", stream: "threads" }] },
  });
  assert.match(html, /Rejected records/);
  assert.match(html, /permanently rejected 2 records in this run/);
  assert.match(html, /<code>messages<\/code>/);
  assert.match(html, /<code>threads<\/code>/);
  assert.match(html, /<code>schema violation<\/code>/);
  assert.doesNotMatch(html, /Unaccounted records/);
  assert.doesNotMatch(html, /show more/);
});

test("shows a show-more link to the next receipt page when the server has one", () => {
  const html = render({
    moreReceiptsHref: "/syncs/run_1?receipts_cursor=abc",
    outcomes: { ...clean, permanently_rejected: 30 },
    receipts: { nextCursor: "abc", receipts: [receipt] },
  });
  assert.match(html, /href="\/syncs\/run_1\?receipts_cursor=abc"/);
  assert.match(html, /show more receipts/);
});

test("shows the unaccounted count per stream", () => {
  const html = render({ outcomes: { ...clean, unaccounted_by_stream: { bodies: 3, photos: 1 } } });
  assert.match(html, /Unaccounted records/);
  assert.match(html, /<code>bodies<\/code>/);
  assert.match(html, /3 unaccounted records/);
  assert.match(html, /1 unaccounted record</);
  assert.doesNotMatch(html, /Rejected records/);
});

test("says the receipt list is unavailable when the total is positive and the read failed", () => {
  const html = render({ outcomes: { ...clean, permanently_rejected: 2 }, receipts: null });
  assert.match(html, /permanently rejected 2 records/);
  assert.match(html, /receipt list is unavailable/);
});

test("renders nothing when both totals are zero, or when there is no run status", () => {
  assert.equal(render({ outcomes: clean }), "");
  assert.equal(render({ outcomes: null }), "");
});

test("a total the server did not report is not shown as zero, and receipts still list", () => {
  const html = render({
    outcomes: { permanently_rejected: null, unaccounted_by_stream: {} },
    receipts: { nextCursor: null, receipts: [receipt] },
  });
  assert.match(html, /<code>messages<\/code>/);
  assert.doesNotMatch(html, /permanently rejected/);
  assert.doesNotMatch(html, /receipt list is unavailable/);
  assert.equal(render({ outcomes: { permanently_rejected: null, unaccounted_by_stream: {} } }), "");
});
