// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { buildSourcesDemoSummaries } from "./sources-demo-data.ts";
import { SourcesView } from "./sources-view.tsx";
import { toSourcesView } from "./sources-view-model.ts";
import { buildUpdatesReadyDemo, readUpdatesReadySafely, type UpdatesReadyModel } from "./updates-ready-model.ts";

Object.assign(globalThis, { React });

function listElement(updates: Promise<UpdatesReadyModel | null>) {
  const router = { back() {}, forward() {}, push() {}, replace() {}, refresh() {}, prefetch: async () => {}, hmrRefresh() {} };
  const noopFormAction = async () => {};
  const noopRunNowAction = async () => ({
    ok: true as const,
    run_id: "test-run",
    trace_id: "test-run",
  });
  return (
    createElement(AppRouterContext.Provider, { value: router as never },
      createElement(SourcesView, {
        instances: toSourcesView(buildSourcesDemoSummaries("healthy")),
        interactive: false,
        reactivateAction: noopFormAction,
        resumeAction: noopFormAction,
        resumeScheduleAction: noopFormAction,
        resumeSetupAction: noopFormAction,
        revokeAction: noopFormAction,
        runNowAction: noopRunNowAction,
        updatesReady: updates,
      })
    )
  );
}

function renderList(updates: Promise<UpdatesReadyModel | null>): string {
  return renderToStaticMarkup(listElement(updates));
}

/** Waits for every Suspense boundary, so the update line has really settled. */
async function prerenderList(updates: Promise<UpdatesReadyModel | null>): Promise<string> {
  const { prelude } = await prerender(listElement(updates));
  return new Response(prelude).text();
}

// DIRECTION.md, “Data sources /sources”: a failed update read shows no update line.
test("the update read resolves to no line when it rejects, throws or is partial", async () => {
  assert.equal(await readUpdatesReadySafely(() => Promise.reject(new Error("unavailable"))), null);
  assert.equal(await readUpdatesReadySafely(() => {
    throw new Error("thrown before a promise");
  }), null);
  assert.equal(await readUpdatesReadySafely(() => Promise.resolve({
    existingSources: { byConnector: { calendar: [{ displayName: "Calendar" }] }, truncated: true },
    snapshot: null,
  })), null);
});

// DIRECTION.md, “Data sources /sources”: a settled update read places its line above the list (positive control for the tests below).
test("a settled update read shows its line above the list", async () => {
  const markup = await prerenderList(Promise.resolve(buildUpdatesReadyDemo("update-two").model));
  assert.match(markup, /Updates are ready/);
  assert.ok(markup.indexOf("Updates are ready") < markup.indexOf('data-testid="sources-list"'));
  // Lead decision (list-pictures 6): the update button is outlined; only "Add a data source" is filled.
  assert.match(markup, /<button[^>]*class="[^"]*pdpp-btn--ghost[^"]*"[^>]*>Update both<\/button>/);
});

// DIRECTION.md, “Data sources /sources”: a rejected update read never replaces or blocks the list.
test("list renders when the separate updates read rejects", async () => {
  const markup = await prerenderList(readUpdatesReadySafely(() => Promise.reject(new Error("unavailable"))));
  assert.match(markup, /data-testid="sources-list"/);
  assert.doesNotMatch(markup, /Updates are ready/);
});

// DIRECTION.md, “Data sources /sources”: a read that never resolves leaves an empty update boundary and renders the list.
test("list renders while the separate updates read never resolves", () => {
  const never = readUpdatesReadySafely(() => new Promise(() => {}));
  const markup = renderList(never);
  assert.match(markup, /data-testid="sources-list"/);
  assert.doesNotMatch(markup, /Updates are ready/);
});

// DIRECTION.md, “Data sources /sources”: the page starts the update read apart from the list read and only through the safe wrapper.
test("the list page passes the update read through the safe wrapper", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
  assert.match(page, /const updatesReady = readUpdatesReadySafely\(readConnectorUpdates\);/);
  assert.doesNotMatch(page, /await readConnectorUpdates/);
});

// Review: a count alone hides the names, so the notice lists every affected source under "Show them".
test("a counted notice lists every affected source under Show them / Hide them", async () => {
  const { model } = buildUpdatesReadyDemo("update-four");
  const long = { ...model, counted: true, names: ["Amazon · account 1", "Amazon · account 2", "Chase", "Mail", "Photos"], namesText: "5 data sources" };
  const markup = await prerenderList(Promise.resolve(long));
  assert.match(markup, /Updates are ready<\/strong> for (?:<!-- -->)?5 data sources/);
  assert.match(markup, /<details[^>]*>[\s\S]*Show them[\s\S]*Hide them[\s\S]*<li>Amazon · account 1<\/li>[\s\S]*<li>Amazon · account 2<\/li>[\s\S]*<li>Photos<\/li>/);
  assert.match(markup, /See what changes/);
  assert.match(markup, /Update all/);
});

test("a short named notice has no disclosure", async () => {
  const markup = await prerenderList(Promise.resolve(buildUpdatesReadyDemo("update-two").model));
  assert.doesNotMatch(markup, /Show them/);
});
