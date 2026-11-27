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
import { buildSourcesDemoSummaries, statusSampleConnectionId } from "./sources-demo-data.ts";
import { SourcesView } from "./sources-view.tsx";
import { filterSourcesForList, orderSourcesForList, toSourcesView } from "./sources-view-model.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const BANNED_WORDS_RE =
  /\b(verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i;
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
      // The time may sit in its own item, so compare the words as text, whole and in order; the dot between them is drawn by the style.
      assert.ok(
        renderedCopy(markup).replace(/\s+/g, " ").includes(status.words.replace(" · ", " ")),
        `status words missing for row ${status.row}`
      );
      if (status.words.includes(" · ")) {
        assert.match(markup, /rr-s-row__status-when/, `time not kept whole for row ${status.row}`);
        assert.doesNotMatch(markup, /rr-s-row__status-when[^>]*>[^<]*·/, `dot inside the time for row ${status.row}`);
      }
    }
  }
});

// DIRECTION.md, “What must stay true” item 1: demo scenarios collectively exercise every list status.
test("seeded scenarios include every status row the sources list can show", () => {
  const rows = new Set<number>();
  for (const scenario of ["mixed", "healthy", "attention"] as const) {
    const { summaries } = seededViews(scenario);
    for (const summary of summaries) {
      rows.add(sourceStatusWords(summary, { now: NOW }).row);
    }
  }
  assert.deepEqual(
    [...rows].sort((a, b) => a - b),
    Array.from({ length: 24 }, (_, index) => index + 1)
  );
});

// DIRECTION.md, “Data sources /sources”: attention rows come first, then syncing, then the rest by name.
test("source rows sort by shared needs-you and syncing facts before name", () => {
  const instances = [...seededViews("mixed").instances, ...seededViews("attention").instances];
  const ordered = orderSourcesForList(
    instances.filter((instance) => !(instance.archived || instance.revoked || instance.setupFailed))
  );
  const firstNonUrgent = ordered.findIndex((instance) => instance.statusWords.tone !== "attention");
  assert.ok(firstNonUrgent > 0);
  assert.ok(ordered.slice(0, firstNonUrgent).every((instance) => instance.statusWords.tone === "attention"));
  assert.equal(ordered[firstNonUrgent]?.statusWords.row, 11);
  const byName = ordered.slice(firstNonUrgent + 1).map((instance) => instance.displayName);
  assert.deepEqual(
    byName,
    [...byName].sort((a, b) => a.localeCompare(b))
  );
});

// DIRECTION.md, “Data sources /sources”: filtering is local and matches a name or account.
test("source filters match the current page by name or account without changing its order", () => {
  const { instances } = seededViews("mixed");
  const rows = orderSourcesForList(instances);
  assert.deepEqual(
    filterSourcesForList(rows, "gmail").map((instance) => instance.displayName),
    ["Gmail (personal)"]
  );
  assert.deepEqual(
    filterSourcesForList(rows, "youtube").map((instance) => instance.displayName),
    ["YouTube"]
  );
  assert.equal(filterSourcesForList(rows, "not here").length, 0);
});

// DIRECTION.md, “Data sources /sources”: the new row actions use real links/buttons and a Base UI menu.
test("sources rows link to their own page and use the shared keyboard menu", async () => {
  const [src, model] = await Promise.all([
    readFile(new URL("./sources-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("./sources-view-model.ts", import.meta.url), "utf8"),
  ]);
  assert.match(
    src,
    /<Link aria-label=\{`Open \$\{instance\.displayName\}`\} className="rr-s-row__link" href=\{instance\.detailHref\}>/
  );
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
  const branch = src.slice(
    src.indexOf('result.reason === "already_running"'),
    src.indexOf("} else {", src.indexOf('result.reason === "already_running"'))
  );
  assert.match(branch, /message: result\.message/);
  assert.match(branch, /syncHref: result\.run_id \? `\/syncs\/\$\{encodeURIComponent\(result\.run_id\)\}` : undefined/);
});

// DIRECTION.md, “What must stay true” item 3: seeded row status copy contains no technical words.
test("status copy rendered for every seeded scenario avoids banned words", () => {
  for (const scenario of ["mixed", "healthy", "attention"] as const) {
    const summaries = buildSourcesDemoSummaries(scenario);
    const instances = toSourcesView(summaries, { now: NOW });
    const router = {
      back() {},
      forward() {},
      push() {},
      replace() {},
      refresh() {},
      prefetch: async () => {},
      hmrRefresh() {},
    };
    const html = renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: router as never },
        createElement(SourcesView, {
          instances,
          interactive: false,
          reactivateAction: noopFormAction,
          resumeAction: noopFormAction,
          resumeScheduleAction: noopFormAction,
          resumeSetupAction: noopFormAction,
          revokeAction: noopFormAction,
          runNowAction: noopRunNowAction,
        })
      )
    );
    assert.doesNotMatch(renderedCopy(html), BANNED_WORDS_RE, scenario);
  }
});

// DIRECTION.md, “Data sources /sources”: the loading placeholder has a title bar and rows without a detail panel.
test("sources loading placeholder uses the list skeleton shape", async () => {
  const loading = await readFile(new URL("./loading.tsx", import.meta.url), "utf8");
  assert.match(loading, /<SourcesLoadingSkeleton \/>/);
  assert.doesNotMatch(loading, /rr-s-loading__panel|passport|master-detail/);
});

function renderSourcesView(instances: ReturnType<typeof toSourcesView>, pagingInPlay = false): string {
  const router = {
    back() {},
    forward() {},
    push() {},
    replace() {},
    refresh() {},
    prefetch: async () => {},
    hmrRefresh() {},
  };
  return renderToStaticMarkup(
    createElement(
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
    )
  );
}

// DIRECTION.md, “What must stay true” item 2: each count names what it counts. An archived data source
// that was also revoked is counted once, under Archived, as the list did before the change.
test("an archived and revoked data source appears only in the Archived group", () => {
  const { instances } = seededViews("mixed");
  const base = instances.find((instance) => !(instance.archived || instance.revoked || instance.setupFailed));
  assert.ok(base);
  const html = renderSourcesView([{ ...base, archived: true, id: "archived-revoked", revoked: true }]);
  assert.match(html, /Archived · 1/);
  assert.doesNotMatch(html, /Disconnected · /);
});

// DIRECTION.md, “Data sources /sources” decision 6 (brief): the note counts the rows the filter acts on.
test("the paging filter note counts only the rows the filter searches", () => {
  const { instances } = seededViews("mixed");
  const listed = instances.filter((instance) => !(instance.archived || instance.revoked || instance.setupFailed));
  assert.ok(listed.length > 10, "the mixed scenario must show the filter");
  assert.ok(listed.length < instances.length, "the mixed scenario must hold folded rows too");
  const html = renderSourcesView(instances, true);
  assert.match(html, new RegExp(`Filtering the ${listed.length.toLocaleString()} data sources on this page\\.`));
});

// Lead decision (list-pictures 3): under the name only an account line, which the list read does not
// carry (RefConnectorSummary has no account field), so nothing; never "N kinds".
test("rows show no kind count or kind line under the name", () => {
  for (const scenario of ["mixed", "healthy", "attention"] as const) {
    const html = renderSourcesView(seededViews(scenario).instances);
    assert.doesNotMatch(renderedCopy(html), /\b\d[\d,]* kinds?\b/, scenario);
    assert.doesNotMatch(html, /rr-s-row__account/, scenario);
  }
});

// Lead decision (list-pictures 2, item 2): a renamed data source still says what it is; an unrenamed one adds nothing.
test("a renamed row shows the connector's name under it; an unrenamed row shows nothing", () => {
  const { instances } = seededViews("mixed");
  const renamed = instances.find((instance) => instance.displayName === "workstation");
  assert.ok(renamed, "the mixed sample must hold a renamed row");
  assert.equal(renamed.listKind, "Signal");
  const html = renderSourcesView([renamed]);
  assert.match(html, /<span class="[^"]*rr-s-row__kind[^"]*"[^>]*>Signal<\/span>/);
  const same = instances.find((instance) => instance.displayName === "Gmail (personal)");
  assert.ok(same);
  assert.doesNotMatch(renderSourcesView([same]), /rr-s-row__kind/);
});

// Lead decision (list-pictures 1): the retained-history ("Version churn") notice is not on the list.
test("the list shows no retained-history notice", async () => {
  const [view, page] = await Promise.all([
    readFile(new URL("./sources-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("./page.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(view, /ChurnNotice|sources-version-churn|Retained history/);
  assert.doesNotMatch(page, /churnAdvisory|buildSourcesChurnAdvisory/);
  for (const scenario of ["mixed", "healthy", "attention"] as const) {
    const copy = renderedCopy(renderSourcesView(seededViews(scenario).instances));
    assert.doesNotMatch(copy, /Version churn|retained|\bKB\b/i, scenario);
  }
});

// DIRECTION.md, “Data sources /sources” and lead decision (list-pictures 4): the filter box appears only
// above more than ten rows; its label is for screen readers and the placeholder labels it on screen.
test("the filter appears only for more than ten rows, labelled by its placeholder", () => {
  const listed = seededViews("mixed").instances.filter(
    (instance) => !(instance.archived || instance.revoked || instance.setupFailed)
  );
  assert.ok(listed.length > 10);
  const long = renderSourcesView(listed);
  assert.match(long, /<label class="sr-only" for="sources-filter">Filter data sources<\/label>/);
  assert.match(long, /placeholder="Filter by name or account"/);
  const short = renderSourcesView(listed.slice(0, 10));
  assert.doesNotMatch(short, /sources-filter/);
});

// DIRECTION.md, Values (changed 2026-11-25) and lead decision (list-pictures 6): every row button is outlined.
test("every row action is outlined, including filled status actions", () => {
  for (const scenario of ["mixed", "healthy", "attention"] as const) {
    const { instances } = seededViews(scenario);
    const html = renderSourcesView(instances);
    const rowButtons = [...html.matchAll(/<(?:button|a)[^>]*class="([^"]*pdpp-btn[^"]*)"[^>]*>/g)].map(
      (match) => match[1] ?? ""
    );
    if (instances.some((instance) => instance.statusWords.action)) {
      assert.ok(rowButtons.length > 0, scenario);
    }
    for (const className of rowButtons) {
      assert.match(className, /pdpp-btn--ghost/, `${scenario}: ${className}`);
    }
  }
});

// Lead decision (list-pictures 8): each status row has one real-looking sample, still pinned to its row.
test("each status sample keeps its status row under a real-looking name", () => {
  const byConnection = new Map(
    (["mixed", "healthy", "attention"] as const)
      .flatMap((scenario) => buildSourcesDemoSummaries(scenario))
      .map((summary) => [summary.connection_id, summary])
  );
  for (let row = 1; row <= 24; row++) {
    const summary = byConnection.get(statusSampleConnectionId(row as Parameters<typeof statusSampleConnectionId>[0]));
    assert.ok(summary, `row ${row} has a sample`);
    assert.equal(sourceStatusWords(summary, { now: NOW }).row, row, summary.display_name);
    assert.doesNotMatch(summary.display_name, /^Sample\b|\d/, `row ${row}`);
  }
  for (const scenario of ["mixed", "healthy", "attention"] as const) {
    const names = buildSourcesDemoSummaries(scenario).map((summary) => summary.display_name);
    assert.equal(new Set(names).size, names.length, `${scenario} repeats a name`);
  }
});

// The duplicate-label notice reviews live data sources only, as before the change: archived and
// unfinished setups are not part of a set of live accounts.
test("archived and unfinished setups do not trigger the duplicate-label notice", () => {
  const { instances } = seededViews("mixed");
  const base = instances.find((instance) => !(instance.archived || instance.revoked || instance.setupFailed));
  assert.ok(base);
  const copies = [1, 2, 3].map((n) => ({
    ...base,
    archived: n !== 1,
    id: `dup-${n}`,
    needsOwnerLabel: true,
    setupFailed: false,
  }));
  copies.push({ ...base, id: "dup-4", needsOwnerLabel: true, setupFailed: true });
  assert.doesNotMatch(renderSourcesView(copies), /sources-duplicate-review/);
  const live = [1, 2].map((n) => ({ ...base, id: `live-${n}`, needsOwnerLabel: true }));
  assert.match(renderSourcesView(live), /sources-duplicate-review/);
});
