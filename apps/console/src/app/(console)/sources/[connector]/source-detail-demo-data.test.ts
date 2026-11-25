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
    const visibleText = html.replace(/<[^>]*>/g, " ");

    // DIRECTION.md §One data source: render the pure helper's sentence and status row on the page.
    assert.equal(status.row, row, `demo row ${row}`);
    assert.ok(html.includes(sentence.text), `sentence for row ${row}`);
    assert.ok(html.includes(`data-status-row="${row}"`), `status row attribute ${row}`);
    assert.ok(html.includes(`data-source-id="${model.connectionId}"`), `source id attribute ${row}`);
    assert.doesNotMatch(html, /<(?:a|button)\b/, `status sentence must not contain controls for row ${row}`);
    assert.doesNotMatch(visibleText, /\b(verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i, `plain words for row ${row}`);
    assert.ok(!visibleText.includes(model.connectionId), `raw source id is not visible for row ${row}`);
    if (status.action) assert.equal(typeof status.action.filled, "boolean", `single status action for row ${row}`);
    if (sentence.slot === "what_you_can_do") {
      assert.ok(html.includes(`Use “${status.action?.label}” above.`), `action guidance for row ${row}`);
    }
  }
});

test("the existing atlas recovery demo remains the row 16 scenario", () => {
  const model = buildRecoveryDemoModel();
  // DIRECTION.md §One data source: preserve the existing ?demo=atlas scenario while adding status cases.
  assert.equal(sourceStatusWords(model.source, { now: NOW }).row, 16);
});

test("the per-kind collection line shows no internal axis word", () => {
  const model = buildRecoveryDemoModel();
  assert.ok(model.collectionFactsByStream.size > 0, "the atlas demo seeds collection facts");
  for (const facts of model.collectionFactsByStream.values()) {
    const html = renderToStaticMarkup(createElement(StreamCollectionFactsLine, { facts }));
    const text = html.replace(/<[^>]*>/g, " ");
    // PAGE-RULES item 6 / DIRECTION.md "What must stay true" 3: "coverage" is not shown outside Details.
    assert.doesNotMatch(text, /\bcoverage\b/i);
  }
});
