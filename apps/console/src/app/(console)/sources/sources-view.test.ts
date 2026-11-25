// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceStatusWords } from "../lib/source-status-words.ts";
import { SourceRowStatus } from "./source-row-status.tsx";
import { buildSourcesDemoChurnRows, buildSourcesDemoSummaries } from "./sources-demo-data.ts";
import { SourcesView } from "./sources-view.tsx";
import {
  buildSourcesChurnAdvisory,
  filterSourcesForList,
  orderSourcesForList,
  toSourcesView,
} from "./sources-view-model.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const BANNED_WORDS_RE = /\b(verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i;
const noopFormAction = async () => {};
const noopRunNowAction = async () => ({
  ok: true as const,
  run_id: "test-run",
  trace_id: "test-run",
});

Object.assign(globalThis, { React });

function seededViews(scenario: "mixed" | "healthy" | "attention") {
  const summaries = buildSourcesDemoSummaries(scenario);
  return {
    summaries,
    instances: toSourcesView(summaries, { now: NOW }),
  };
}

function renderedCopy(markup: string): string {
  const text = markup.replace(/<[^>]*>/g, " ");
  const accessibleLabels = [...markup.matchAll(/(?:aria-label|alt|placeholder|title)="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .join(" ");
  return `${text} ${accessibleLabels}`;
}

// DIRECTION.md, “Data sources /sources”: status words and row number come from the shared status result.
test("each rendered source status carries the shared words, status row, and connection id", () => {
  for (const scenario of ["mixed", "healthy", "attention"] as const) {
    const { summaries, instances } = seededViews(scenario);
    for (const summary of summaries) {
      const instance = instances.find((row) => row.connectionId === summary.connection_id);
      assert.ok(instance, `missing projected source ${summary.connection_id}`);
      const status = sourceStatusWords(summary, { now: NOW });
      const markup = renderToStaticMarkup(createElement(SourceRowStatus, { instance }));
      assert.match(markup, new RegExp(`data-status-row="${status.row}"`));
      assert.match(markup, new RegExp(`data-source-id="${summary.connection_id}"`));
      assert.ok(markup.includes(status.words), `status words missing for row ${status.row}`);
    }
  }
});

// DIRECTION.md, “What must stay true” item 1: demo scenarios collectively exercise every list status.
test("seeded scenarios include every status row the sources list can show", () => {
  const rows = new Set<number>();
  for (const scenario of ["mixed", "healthy", "attention"] as const) {
    const { summaries } = seededViews(scenario);
    for (const summary of summaries) rows.add(sourceStatusWords(summary, { now: NOW }).row);
  }
  assert.deepEqual([...rows].sort((a, b) => a - b), Array.from({ length: 24 }, (_, index) => index + 1));
});

// DIRECTION.md, “Data sources /sources”: attention rows come first, then syncing, then the rest by name.
test("source rows sort by shared needs-you and syncing facts before name", () => {
  const instances = [...seededViews("mixed").instances, ...seededViews("attention").instances];
  const ordered = orderSourcesForList(instances.filter((instance) => !instance.archived && !instance.revoked && !instance.setupFailed));
  const firstNonUrgent = ordered.findIndex((instance) => !instance.statusWords.needsYou);
  assert.ok(firstNonUrgent > 0);
  assert.ok(ordered.slice(0, firstNonUrgent).every((instance) => instance.statusWords.needsYou));
  assert.equal(ordered[firstNonUrgent]?.statusWords.row, 11);
  const byName = ordered.slice(firstNonUrgent + 1).map((instance) => instance.displayName);
  assert.deepEqual(byName, [...byName].sort((a, b) => a.localeCompare(b)));
});

// DIRECTION.md, “Data sources /sources”: filtering is local and matches a name or account.
test("source filters match the current page by name or account without changing its order", () => {
  const { instances } = seededViews("mixed");
  const rows = orderSourcesForList(instances);
  assert.deepEqual(filterSourcesForList(rows, "gmail").map((instance) => instance.displayName), ["Gmail (personal)"]);
  assert.deepEqual(filterSourcesForList(rows, "sample 16").map((instance) => instance.displayName), ["Sample 16"]);
  assert.equal(filterSourcesForList(rows, "not here").length, 0);
});

// DIRECTION.md, “Data sources /sources”: the new row actions use real links/buttons and a Base UI menu.
test("sources rows link to their own page and use the shared keyboard menu", async () => {
  const [src, model] = await Promise.all([
    readFile(new URL("./sources-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("./sources-view-model.ts", import.meta.url), "utf8"),
  ]);
  assert.match(src, /<Link aria-label=\{`Open \$\{instance\.displayName\}`\} className="rr-s-row__link" href=\{instance\.detailHref\}>/);
  assert.match(src, /import \{ Menu \} from "@base-ui\/react\/menu"/);
  assert.match(src, /<Menu\.Trigger aria-label=\{`More actions for \$\{instance\.displayName\}`\}/);
  // DIRECTION.md, “Data sources /sources”: the menu model supplies its visible destination label.
  assert.match(model, /label: "Open this data source"/);
  assert.match(src, /UpdatesReadySlot/);
});

// DIRECTION.md, “Data sources /sources”: without a device id in the list read, the device action keeps the detail route.
test("View this device links to the data source page when the list has no device id", () => {
  const base = seededViews("mixed").instances[0];
  assert.ok(base);
  const local = {
    ...base,
    isLocalDevicePush: true,
    sourceKind: "local_device" as const,
    statusWords: {
      ...base.statusWords,
      action: { kind: "view_device" as const, label: "View this device", filled: false },
    },
  };
  const html = renderSourcesView([local]);
  assert.ok(html.includes(`href="${local.detailHref}"`));
  assert.match(renderedCopy(html), /View this device/);
});

// DIRECTION.md, “Data sources /sources”: a successful row action links to the returned sync detail.
test("source row success toast links to the concrete sync page", async () => {
  const src = await readFile(new URL("./sources-view.tsx", import.meta.url), "utf8");
  assert.match(src, /syncHref: result\.run_id \? `\/syncs\/\$\{encodeURIComponent\(result\.run_id\)\}` : undefined/);
  assert.match(src, /<Link href=\{toast\.syncHref\}>See this sync<\/Link>/);
});

// DIRECTION.md, “Data sources /sources”: an already-running response keeps the server message and active sync link.
test("source row already-running toast retains the active sync ID", async () => {
  const src = await readFile(new URL("./sources-view.tsx", import.meta.url), "utf8");
  const branch = src.slice(src.indexOf('result.reason === "already_running"'), src.indexOf("} else {", src.indexOf('result.reason === "already_running"')));
  assert.match(branch, /message: result\.message/);
  assert.match(branch, /syncHref: result\.run_id \? `\/syncs\/\$\{encodeURIComponent\(result\.run_id\)\}` : undefined/);
});

// DIRECTION.md, “What must stay true” item 3: seeded row status copy contains no technical words.
test("status copy rendered for every seeded scenario avoids banned words", () => {
  for (const scenario of ["mixed", "healthy", "attention"] as const) {
    const summaries = buildSourcesDemoSummaries(scenario);
    const instances = toSourcesView(summaries, { now: NOW });
    const router = { back() {}, forward() {}, push() {}, replace() {}, refresh() {}, prefetch: async () => {}, hmrRefresh() {} };
    const html = renderToStaticMarkup(createElement(
      AppRouterContext.Provider,
      { value: router as never },
      createElement(SourcesView, {
        churnAdvisory: buildSourcesChurnAdvisory(buildSourcesDemoChurnRows(scenario)),
        instances,
        interactive: false,
        reactivateAction: noopFormAction,
        resumeAction: noopFormAction,
        resumeScheduleAction: noopFormAction,
        resumeSetupAction: noopFormAction,
        revokeAction: noopFormAction,
        runNowAction: noopRunNowAction,
      })
    ));
    assert.doesNotMatch(renderedCopy(html), BANNED_WORDS_RE, scenario);
  }
});

// DIRECTION.md, “Data sources /sources”: the loading placeholder has a title bar and rows without a detail panel.
test("sources loading placeholder uses the list skeleton shape", async () => {
  const loading = await readFile(new URL("./loading.tsx", import.meta.url), "utf8");
  assert.match(loading, /ListLoadingSkeleton label="data sources" rows=\{6\}/);
  assert.doesNotMatch(loading, /rr-s-loading__panel|passport|master-detail/);
});

function renderSourcesView(instances: ReturnType<typeof toSourcesView>, pagingInPlay = false): string {
  const router = { back() {}, forward() {}, push() {}, replace() {}, refresh() {}, prefetch: async () => {}, hmrRefresh() {} };
  return renderToStaticMarkup(createElement(
    AppRouterContext.Provider,
    { value: router as never },
    createElement(SourcesView, {
      instances,
      interactive: false,
      pagingInPlay,
      reactivateAction: noopFormAction,
      resumeAction: noopFormAction,
      resumeScheduleAction: noopFormAction,
      resumeSetupAction: noopFormAction,
      revokeAction: noopFormAction,
      runNowAction: noopRunNowAction,
    })
  ));
}

// DIRECTION.md, “What must stay true” item 2: each count names what it counts. An archived data source
// that was also revoked is counted once, under Archived, as the list did before the change.
test("an archived and revoked data source appears only in the Archived group", () => {
  const { instances } = seededViews("mixed");
  const base = instances.find((instance) => !instance.archived && !instance.revoked && !instance.setupFailed);
  assert.ok(base);
  const html = renderSourcesView([{ ...base, archived: true, id: "archived-revoked", revoked: true }]);
  assert.match(html, /Archived · 1/);
  assert.doesNotMatch(html, /Disconnected · /);
});

// DIRECTION.md, “Data sources /sources” decision 6 (brief): the note counts the rows the filter acts on.
test("the paging filter note counts only the rows the filter searches", () => {
  const { instances } = seededViews("mixed");
  const listed = instances.filter((instance) => !instance.archived && !instance.revoked && !instance.setupFailed);
  assert.ok(listed.length > 10, "the mixed scenario must show the filter");
  assert.ok(listed.length < instances.length, "the mixed scenario must hold folded rows too");
  const html = renderSourcesView(instances, true);
  assert.match(html, new RegExp(`Filtering the ${listed.length.toLocaleString()} data sources on this page\\.`));
});

// Task extra check (d): one of a thing reads in the singular.
test("a data source with one kind of record says 1 kind", () => {
  const { instances } = seededViews("mixed");
  const base = instances.find((instance) => !instance.archived && !instance.revoked && !instance.setupFailed && instance.streams.length > 0);
  assert.ok(base);
  const html = renderSourcesView([{ ...base, listKind: null, streams: base.streams.slice(0, 1) }]);
  assert.match(html, />1 kind</);
  assert.doesNotMatch(html, /1 kinds/);
});

// The duplicate-label notice reviews live data sources only, as before the change: archived and
// unfinished setups are not part of a set of live accounts.
test("archived and unfinished setups do not trigger the duplicate-label notice", () => {
  const { instances } = seededViews("mixed");
  const base = instances.find((instance) => !instance.archived && !instance.revoked && !instance.setupFailed);
  assert.ok(base);
  const copies = [1, 2, 3].map((n) => ({ ...base, archived: n !== 1, id: `dup-${n}`, needsOwnerLabel: true, setupFailed: false }));
  copies.push({ ...base, id: "dup-4", needsOwnerLabel: true, setupFailed: true });
  assert.doesNotMatch(renderSourcesView(copies), /sources-duplicate-review/);
  const live = [1, 2].map((n) => ({ ...base, id: `live-${n}`, needsOwnerLabel: true }));
  assert.match(renderSourcesView(live), /sources-duplicate-review/);
});
