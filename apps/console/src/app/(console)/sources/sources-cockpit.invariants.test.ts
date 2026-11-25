// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CSS_FILE = `${HERE}sources-view.css`;
const VIEW_FILE = `${HERE}sources-view.tsx`;
const SOURCE_PAGE_FILE = `${HERE}[connector]/page.tsx`;
const STREAM_FACTS_FILE = `${HERE}[connector]/stream-collection-facts.tsx`;

// DIRECTION.md, “Data sources /sources”: every screen uses one list, and each row opens its data source page.
test("the sources page renders one list and no selected-source panel", async () => {
  const [view, css] = await Promise.all([
    readFile(VIEW_FILE, "utf8"),
    readFile(CSS_FILE, "utf8"),
  ]);
  assert.match(view, /aria-label="Data sources"[\s\S]*<ul className="rr-s-list">/);
  assert.match(view, /className="rr-s-row__link" href=\{instance\.detailHref\}/);
  assert.doesNotMatch(view, /SourcePassport|rr-s-passport|Streams on this source/);
  assert.doesNotMatch(css, /\.rr-s-(?:item|passport|detail)\b/);
});

// DIRECTION.md, “Data sources /sources”: desktop uses the five specified columns and one menu column.
test("desktop rows use the data, status, records, schedule, action, and menu columns", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  assert.match(css, /\.rr-s\s*\{[^}]*max-width:\s*1040px/);
  // Lead decision (list-pictures 2): header and rows share fixed tracks; the row link is a subgrid of them.
  assert.match(css, /--rr-s-tracks:\s*minmax\(0,\s*1fr\)\s+260px\s+90px\s+120px\s+120px\s+40px/);
  assert.match(css, /\.rr-s-columns,\s*\.rr-s-row\s*\{[^}]*grid-template-columns:\s*var\(--rr-s-tracks\)/);
  assert.match(css, /\.rr-s-row__link\s*\{[^}]*grid-column:\s*1 \/ 5;[^}]*grid-template-columns:\s*subgrid/);
  assert.match(css, /\.rr-s-row__records\s*\{[^}]*text-align:\s*right/);
});

// DIRECTION.md, “Data sources /sources”: phone rows put status below identity and hide the other columns.
test("phone rows keep identity, status, and action while hiding records and schedule", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  // Lead decision (list-pictures 7): the narrow layout follows the list's own width; the menu sits on the
  // name line and the action goes beneath the status, aligned with the text.
  assert.match(css, /@container rr-s-list \(max-width:\s*720px\)[\s\S]*?\.rr-s-row__link\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.rr-s-menu-trigger\s*\{\s*grid-column:\s*2;\s*grid-row:\s*1;/);
  assert.match(css, /\.rr-s-row__action,\s*\.rr-s-row__action-form\s*\{\s*grid-column:\s*1;\s*grid-row:\s*2;[^}]*margin-left:\s*46px/);
  assert.match(css, /\.rr-s-row__records,\s*\.rr-s-row__schedule\s*\{\s*display:\s*none/);
  assert.match(css, /\.rr-s-row__status\s*\{\s*padding-left:\s*46px/);
});

// DIRECTION.md, “Data sources /sources”: row state changes the words, not the row geometry.
test("status tone does not add row-specific geometry or a selected-source rail", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  assert.doesNotMatch(css, /\.rr-s-row(?:__status)?(?:\[data-[^\]]+\]|\.[a-z-]+)\s*\{[^}]*?(?:margin|width|border-radius)\s*:/i);
  assert.doesNotMatch(css, /\.rr-s-row\.is-on|\.rr-s-row__link\.is-on/);
});

// DIRECTION.md, “One data source”: per-kind counts and collection facts stay on the source page.
test("the source page keeps the moved per-kind list and its collection facts", async () => {
  const [page, facts] = await Promise.all([
    readFile(SOURCE_PAGE_FILE, "utf8"),
    readFile(STREAM_FACTS_FILE, "utf8"),
  ]);
  // detail-page-2 decision 6: the title alone; coverage facts are a plain line inside folded Details, not a chip.
  assert.match(page, /title="What is here"/);
  assert.match(page, /streamCountLabel\(s\)/);
  assert.match(page, /<StreamCollectionFactsLine\s+facts=\{facts\}/);
  assert.match(facts, /data-testid="stream-coverage-fact"/);
  assert.match(facts, /data-testid="stream-collected-counts"/);
  assert.match(facts, /data-testid="stream-forward-disposition"/);
});

// DIRECTION.md, “Data sources /sources”: duplicate sources keep an individual row under one shared review notice.
test("duplicate sources are not collapsed out of the list", async () => {
  const [view, model] = await Promise.all([
    readFile(VIEW_FILE, "utf8"),
    readFile(`${HERE}sources-view-model.ts`, "utf8"),
  ]);
  assert.match(view, /buildDuplicateSourceReview/);
  assert.match(view, /filteredRows\.map\([\s\S]*?<SourceRow/);
  assert.doesNotMatch(view, /collapseDuplicateFallbackSources/);
  assert.match(model, /return visibleSummaries\.map\(/);
});

// DIRECTION.md, “Data sources /sources”: the status action owns the row action; other labels open the safe detail address.
test("server CTA row actions keep their label without inventing a run", async () => {
  const view = await readFile(VIEW_FILE, "utf8");
  assert.match(view, /primaryVerdictAction\.kind === "refresh_now" \|\| instance\.primaryVerdictAction\.kind === "retry_gap"/);
  assert.match(view, /<Link className=\{`\$\{buttonVariants\([\s\S]*?href=\{instance\.detailHref\}/);
});
