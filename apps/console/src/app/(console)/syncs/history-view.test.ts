// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import test from "node:test";
import { DEMO_SYNCS_MODEL } from "./syncs-demo.ts";
import { recentSyncPhrase, recentSyncsFilterHref, SyncsView, type RecentSyncsPaging } from "./syncs-view.tsx";
import type { RecentSyncEntry } from "./syncs-model.ts";

// The shared primitives use the classic JSX transform in this Node render path.
(globalThis as typeof globalThis & { React?: typeof React }).React = React;

const BANNED_VISIBLE_WORDS = /\b(verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i;
const FINAL_ROW_BORDER_CLASS_RE = /last:border-b-0/;
const FILTER_CAP_NOTE_RE = /Only the first 1,000 data sources are listed here\./;
const paging: RecentSyncsPaging = {
  connectorOptions: [
    { label: "All data sources", value: "" },
    { label: "Amazon", value: "amazon" },
  ],
  hasMore: true,
  isPaged: false,
  nextCursor: "next",
  params: {},
  statusOptions: [
    { label: "Any result", value: "" },
    { label: "Failed", value: "failed" },
  ],
};

function visibleHistoryText(model: typeof DEMO_SYNCS_MODEL, pagingState: RecentSyncsPaging, includeDetails = false) {
  const html = renderToStaticMarkup(
    createElement(SyncsView, {
      model,
      recentSyncsPaging: pagingState,
      sourceSummaries: [],
    })
  );
  const document = new JSDOM(html).window.document;
  if (!includeDetails) {
    for (const details of document.querySelectorAll("details")) details.remove();
  }
  return { document, text: document.body.textContent ?? "" };
}

test("history rows use one plain phrase for the result", () => {
  // DIRECTION.md, Values: each row uses a short phrase and words for its time.
  assert.equal(
    recentSyncPhrase({ outcome: "ok", status: "succeeded" } as RecentSyncEntry, false),
    "Sync finished"
  );
  assert.equal(recentSyncPhrase({ outcome: "failed", status: "failed" } as RecentSyncEntry, false), "Sync failed");
  assert.equal(recentSyncPhrase({ outcome: "ok", status: "succeeded" } as RecentSyncEntry, true), "Needs you");
});

test("history empty, row, and filtered states show their values without banned words", () => {
  const empty = visibleHistoryText({ ...DEMO_SYNCS_MODEL, recentSyncs: [] }, paging);
  assert.match(empty.text, /Syncs appear here when a data source finishes/);
  assert.match(empty.text, /All data sources/);
  assert.match(empty.text, /Any result/);
  assert.doesNotMatch(empty.text, BANNED_VISIBLE_WORDS);

  const filtered = visibleHistoryText(
    { ...DEMO_SYNCS_MODEL, recentSyncs: [] },
    { ...paging, params: { status: "failed" } }
  );
  assert.match(filtered.text, /No syncs match these filters/);
  assert.match(filtered.text, /Failed/);
  assert.doesNotMatch(filtered.text, BANNED_VISIBLE_WORDS);

  const rows = visibleHistoryText(DEMO_SYNCS_MODEL, paging);
  assert.ok(DEMO_SYNCS_MODEL.recentSyncs.length > 0, "demo data must include at least one sync row");
  // history-repair brief P3: one line separates the final row from page Details.
  const finalRow = rows.document.querySelector('[data-testid="syncs-recent-list"] ul li:last-child');
  assert.ok(finalRow);
  assert.match(finalRow.className, FINAL_ROW_BORDER_CLASS_RE);
  assert.match(rows.text, /Show more/);
  assert.doesNotMatch(rows.document.querySelector("a > span:nth-child(2) > span:first-child")?.className ?? "", /\btruncate\b/);
  assert.doesNotMatch(rows.text, BANNED_VISIBLE_WORDS);

  const details = visibleHistoryText(DEMO_SYNCS_MODEL, paging, true);
  assert.match(details.text, /Sync failed/);
  assert.doesNotMatch(details.text, /sync failed/);
});

test("history filters show the applied values on compact keyboard popovers", async () => {
  const { document } = visibleHistoryText(DEMO_SYNCS_MODEL, {
    ...paging,
    params: { connector_id: "amazon", status: "failed" },
  });
  const list = document.querySelector('[data-testid="syncs-recent-list"]');
  assert.ok(list);
  const triggers = [...list.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')];
  assert.deepEqual(triggers.map((trigger) => trigger.textContent?.trim()), ["Amazon⌄", "Failed⌄"]);
  assert.equal(list.querySelectorAll("select").length, 0);
  const sourceTrigger = triggers[0];
  assert.ok(sourceTrigger);
  assert.match(sourceTrigger.className, /max-w-\[calc\(100vw-2rem\)\]/);
  assert.match(sourceTrigger.className, /min-\[860px\]:h-\[30px\]/);
  assert.match(sourceTrigger.className, /h-11/);
  const view = await readFile(new URL("syncs-view.tsx", import.meta.url), "utf8");
  assert.match(view, /IcPopoverPopup[\s\S]{0,120}className="max-h-\[min\(24rem,calc\(100vh-2rem\)\)\] w-\[min\(20rem,calc\(100vw-2rem\)\)\]/);
});

test("History shows the source-filter cap note when the server page walk is bounded", () => {
  const note = "Only the first 1,000 data sources are listed here.";
  const result = visibleHistoryText(DEMO_SYNCS_MODEL, { ...paging, sourceFilterNote: note });
  // history-repair brief P2: a bounded source-filter walk says when it hits its cap.
  assert.match(result.text, FILTER_CAP_NOTE_RE);
});

test("filter options are links that apply at once, so a portaled popup cannot drop the choice", async () => {
  // The popover popup is portaled to <body> and unmounted while closed, so a
  // radio inside it is never part of a surrounding <form>. Each option is a
  // link that keeps the other filter and every other parameter, and restarts
  // at the newest page.
  const params = { connector_id: "amazon", page_cursor: "p2", run_cursor: "r9", status: "failed" };
  assert.equal(
    recentSyncsFilterHref(params, "status", "succeeded"),
    "/syncs?connector_id=amazon&page_cursor=p2&status=succeeded"
  );
  assert.equal(recentSyncsFilterHref(params, "status", ""), "/syncs?connector_id=amazon&page_cursor=p2");
  assert.equal(
    recentSyncsFilterHref(params, "connector_id", "github"),
    "/syncs?connector_id=github&page_cursor=p2&status=failed"
  );
  const view = await readFile(new URL("syncs-view.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(view, /type="radio"/);
  assert.match(view, /href=\{recentSyncsFilterHref\(params, name, option\.value\)\}/);
});

test("failed History reads use a plain retry sentence and fold the server details", async () => {
  const source = await readFile(new URL("page.tsx", import.meta.url), "utf8");
  assert.match(source, /This could not be loaded\.[\s\S]*?Try again/);
  assert.match(source, /<details className="mt-4">[\s\S]*?<ServerUnreachable \/>/);
});
