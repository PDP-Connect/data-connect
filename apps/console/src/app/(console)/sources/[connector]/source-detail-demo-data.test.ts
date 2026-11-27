// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type SourceStatusRow, sourceStateSentence, sourceStatusWords } from "../../lib/source-status-words.ts";
import { buildRecoveryDemoModel } from "./source-detail-demo-data.ts";
import { SourceStateSentenceText } from "./source-state-sentence.tsx";
import { StreamCollectionFactsLine } from "./stream-collection-facts.tsx";

const NOW = new Date("2026-11-24T12:00:00.000Z");

test("seeded detail scenarios render the shared sentence and row for each status", () => {
  for (let row = 1; row <= 24; row += 1) {
    const model = buildRecoveryDemoModel(row as SourceStatusRow);
    const status = sourceStatusWords(model.source, { now: NOW });
    const sentence = sourceStateSentence(model.source, { now: NOW, name: model.displayName });
    const html = renderToStaticMarkup(
      createElement(SourceStateSentenceText, { connectionId: model.connectionId, sentence, status })
    );
    const visibleText = html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

    // DIRECTION.md §One data source: render the pure helper's sentence and status row on the page.
    assert.equal(status.row, row, `demo row ${row}`);
    // Brief decision 3: the row 8 sentence is split into attention and second-text spans.
    assert.ok(visibleText.includes(sentence.text), `sentence for row ${row}`);
    assert.ok(html.includes(`data-status-row="${row}"`), `status row attribute ${row}`);
    assert.ok(html.includes(`data-source-id="${model.connectionId}"`), `source id attribute ${row}`);
    assert.doesNotMatch(html, /<(?:a|button)\b/, `status sentence must not contain controls for row ${row}`);
    assert.doesNotMatch(visibleText, /\b(verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i, `plain words for row ${row}`);
    assert.ok(!visibleText.includes(model.connectionId), `raw source id is not visible for row ${row}`);
    if (status.action) assert.equal(typeof status.action.filled, "boolean", `single status action for row ${row}`);
    // Brief decision 3: the sentence never points at an action above.
    assert.doesNotMatch(visibleText, /Use “.+” above\./, `no duplicate action instruction for row ${row}`);
  }
});

test("the existing atlas recovery demo remains the row 16 scenario", () => {
  const model = buildRecoveryDemoModel();
  // DIRECTION.md §One data source: preserve the existing ?demo=atlas scenario while adding status cases.
  assert.equal(sourceStatusWords(model.source, { now: NOW }).row, 16);
});

test("per-kind evidence is rendered inside folded Details", () => {
  const model = buildRecoveryDemoModel();
  assert.ok(model.collectionFactsByStream.size > 0, "the atlas demo seeds collection facts");
  for (const facts of model.collectionFactsByStream.values()) {
    const html = renderToStaticMarkup(
      createElement("details", null, createElement("summary", null, "Details"), createElement(StreamCollectionFactsLine, { facts }))
    );
    // Brief decision 6: collection evidence moves into the folded Details section.
    assert.match(html, /<details><summary>Details<\/summary>[\s\S]*stream-collection-facts/);
  }
});

test("pending details replace up-to-date wording on rows 19 and 20", () => {
  for (const row of [19, 20] as const) {
    const model = buildRecoveryDemoModel(row, true);
    const status = sourceStatusWords(model.source, { now: NOW });
    const sentence = sourceStateSentence(model.source, { now: NOW, name: model.displayName, pendingDetails: true });
    const html = renderToStaticMarkup(
      createElement(SourceStateSentenceText, { connectionId: model.connectionId, sentence, status })
    );
    const visibleText = html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

    // Brief decision 5: pending details use the plain sentence and never conflict with “Up to date”.
    assert.match(visibleText, /^Synced .*\. Still checking a few things\.$/);
    assert.doesNotMatch(visibleText, /Up to date|next in|has not checked this against the source/);
  }
});
