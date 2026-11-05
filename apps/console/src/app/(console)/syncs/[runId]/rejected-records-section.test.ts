// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RejectedRecordsSection } from "./rejected-records-section.tsx";

const receipt = {
  firstInputIndex: 4,
  payloadBytes: 120,
  reasonCode: "schema_violation",
  receiptId: "r1",
  stream: "messages",
};

test("the run page shows the rejected-record count and each receipt's stream and reason", () => {
  const html = renderToStaticMarkup(
    createElement(RejectedRecordsSection, {
      receipts: [receipt, { ...receipt, receiptId: "r2", stream: "threads" }],
      summary: { rejectedRecords: 2, rejectedRecordsComplete: true, unaccounted: [] },
    })
  );
  assert.match(html, /Rejected records/);
  assert.match(html, /permanently rejected 2 records/);
  assert.match(html, /<code>messages<\/code>/);
  assert.match(html, /<code>threads<\/code>/);
  assert.match(html, /<code>schema violation<\/code>/);
  assert.doesNotMatch(html, /Unaccounted records/);
});

test("the run page shows the unaccounted count per stream", () => {
  const html = renderToStaticMarkup(
    createElement(RejectedRecordsSection, {
      receipts: null,
      summary: { rejectedRecords: 0, rejectedRecordsComplete: false, unaccounted: [{ stream: "bodies", unaccounted: 3 }] },
    })
  );
  assert.match(html, /Unaccounted records/);
  assert.match(html, /<code>bodies<\/code>/);
  assert.match(html, /3 unaccounted records/);
  assert.doesNotMatch(html, /Rejected records/);
});

test("the rejected count still renders when the receipt list could not be read", () => {
  const html = renderToStaticMarkup(
    createElement(RejectedRecordsSection, {
      receipts: null,
      summary: { rejectedRecords: 1, rejectedRecordsComplete: false, unaccounted: [] },
    })
  );
  assert.match(html, /permanently rejected 1 record in this run/);
  assert.match(html, /covers the events loaded on this page/);
  assert.doesNotMatch(html, /<ul/);
});

test("a run with nothing rejected and nothing unaccounted renders no section", () => {
  const html = renderToStaticMarkup(
    createElement(RejectedRecordsSection, {
      receipts: [],
      summary: { rejectedRecords: 0, rejectedRecordsComplete: true, unaccounted: [] },
    })
  );
  assert.equal(html, "");
});
