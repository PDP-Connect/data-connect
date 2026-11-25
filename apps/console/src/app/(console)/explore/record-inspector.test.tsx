// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ExplorerPeekData } from "@pdpp/operator-ui/components/views/records-explorer-view";
import { RecordInspector } from "../components/record-inspector.tsx";

const RECORD: ExplorerPeekData = {
  bodyJson: JSON.stringify({
    created_at: "2026-11-24T14:30:00.000Z",
    subject: "Re: lunch",
    website: "https://example.com/record",
    conversation_id: "conversation-42",
  }),
  connectionDisplayName: "Personal archive",
  connectionId: "connection-1",
  connectorId: "email",
  emittedAt: "2026-11-24T14:30:00.000Z",
  error: null,
  fields: [
    { name: "subject", state: "visible", type: "string", valueJson: '"Re: lunch"' },
    { name: "created_at", state: "visible", type: "datetime", valueJson: '"2026-11-24T14:30:00.000Z"' },
    { name: "website", state: "visible", type: "url", valueJson: '"https://example.com/record"' },
    { name: "conversation_id", state: "visible", type: "string", valueJson: '"conversation-42"' },
  ],
  readUrl: "/v1/records/email/messages/record-1",
  recordId: "record-1",
  semanticTimestamp: null,
  stream: "messages",
};

const SUBJECT_LABEL_RE = /<span class="rr-fld__label">Subject<\/span>/;
const SUBJECT_VALUE_RE = /Re: lunch/;
const WEB_LINK_RE = /href="https:\/\/example\.com\/record"/;
const TECHNICAL_VISIBLE_COPY_RE = /created_at|record-1|GET|Raw JSON|datetime/;
const DETAILS_SUMMARY_RE = /<summary>Details<\/summary>/;
const REQUEST_DETAILS_RE = /GET \/v1\/records\/email\/messages\/record-1/;
const RAW_JSON_RE = /Raw JSON/;
const FIELD_TYPE_RE = /datetime · visible/;
const FULL_RECORD_LINK_RE = /<a href="\/records\/email\/messages\/record-1">Open full record →<\/a>/;
const IDENTIFIER_DETAIL_RE = /Conversation id · conversation_id<\/dt><dd>conversation-42 · string · visible<\/dd>/;
const IDENTIFIER_NOT_VISIBLE_RE = /conversation-42|Conversation id/;

test("record inspector keeps readable fields visible and technical facts under Details", () => {
  Object.assign(globalThis, { React: { createElement } });
  const markup = renderToStaticMarkup(
    createElement(RecordInspector, {
      record: RECORD,
      recordHref: "/records/email/messages/record-1",
      streamRecordsHref: "/records/email/messages",
    })
  );
  const detailsStart = markup.indexOf("<details");
  assert.notEqual(detailsStart, -1);
  const visible = markup.slice(0, detailsStart);
  const visibleText = visible.replace(/<[^>]+>/g, " ");
  const details = markup.slice(detailsStart);

  assert.match(visible, SUBJECT_LABEL_RE);
  assert.match(visible, SUBJECT_VALUE_RE);
  assert.match(visible, WEB_LINK_RE);
  // Explore repair P2: the full-record link stays visible at the top of the inspector.
  assert.match(visible, FULL_RECORD_LINK_RE);
  assert.doesNotMatch(visibleText, TECHNICAL_VISIBLE_COPY_RE);
  assert.doesNotMatch(visible, IDENTIFIER_NOT_VISIBLE_RE);
  assert.match(details, DETAILS_SUMMARY_RE);
  // Explore repair P2: identifier fields belong inside Details.
  assert.match(details, IDENTIFIER_DETAIL_RE);
  assert.match(details, REQUEST_DETAILS_RE);
  assert.match(details, RAW_JSON_RE);
  assert.match(details, FIELD_TYPE_RE);
});

test("record inspector hides only identifier fields, not content fields that end in or contain id", () => {
  Object.assign(globalThis, { React: { createElement } });
  const nearMisses = { valid: "value-valid", paid: "value-paid", android: "value-android", video: "value-video", ideas: "value-ideas", isPaid: "value-is-paid" };
  const identifiers = { id: "ident-1", userId: "ident-2", "message id": "ident-3", "thread-id": "ident-4", order_ID: "ident-5" };
  const record: ExplorerPeekData = {
    ...RECORD,
    bodyJson: JSON.stringify({ ...nearMisses, ...identifiers }),
    fields: [],
  };
  const markup = renderToStaticMarkup(createElement(RecordInspector, { record, recordHref: null, streamRecordsHref: null }));
  const detailsStart = markup.indexOf("<details");
  assert.notEqual(detailsStart, -1);
  const visible = markup.slice(0, detailsStart);
  const details = markup.slice(detailsStart);
  for (const value of Object.values(nearMisses)) {
    assert.ok(visible.includes(value), `${value} must stay visible`);
  }
  for (const value of Object.values(identifiers)) {
    assert.ok(!visible.includes(value), `${value} must not be visible outside Details`);
    assert.ok(details.includes(value), `${value} must be under Details`);
  }
});
