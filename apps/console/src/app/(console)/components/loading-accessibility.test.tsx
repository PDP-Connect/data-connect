// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("@/app/(console)/components/recordroom-shell-with-palette.tsx", { namedExports: { RecordroomShellWithPalette: ({ children }: { children: React.ReactNode }) => createElement("main", null, children) } });

async function skeletons(): Promise<Record<string, React.ReactElement>> {
  const route = await import("./route-loading.tsx");
  const named = await import("./named-page-loading.tsx");
  const titled = await import("./titled-detail-loading.tsx");
  const { SourcesLoadingSkeleton } = await import("../sources/sources-loading-skeleton.tsx");
  const { SyncHistoryLoadingSkeleton } = await import("../syncs/sync-history-loading-skeleton.tsx");
  const { FirstSyncLoadingSkeleton } = await import("../connect/status/[connectionId]/first-sync-loading-skeleton.tsx");
  const { default: HomeLoading } = await import("../loading.tsx");
  return {
    detail: createElement(route.DetailLoadingSkeleton, { label: "a" }),
    firstSync: createElement(FirstSyncLoadingSkeleton),
    home: createElement(HomeLoading),
    list: createElement(route.ListLoadingSkeleton, { label: "a" }),
    named: createElement(named.NamedPageLoadingSkeleton, { label: "a", shape: "list", title: "A" }),
    page: createElement(route.PageLoadingSkeleton, { label: "a" }),
    sources: createElement(SourcesLoadingSkeleton),
    syncs: createElement(SyncHistoryLoadingSkeleton),
    table: createElement(route.TableLoadingSkeleton, { label: "a" }),
    titled: createElement(titled.TitledDetailLoadingSkeleton, { breadcrumbs: [{ href: "/x", label: "X" }], label: "a" }),
  };
}

test("every loading screen has one status, outside the busy region", async () => {
  for (const [name, element] of Object.entries(await skeletons())) {
    const dom = new JSDOM(`<body>${renderToStaticMarkup(element)}</body>`);
    const statuses = dom.window.document.querySelectorAll('[role="status"]');
    assert.equal(statuses.length, 1, `${name}: exactly one status`);
    assert.equal(statuses[0]?.closest('[aria-busy="true"]'), null, `${name}: the status is not inside aria-busy`);
    assert.ok(dom.window.document.querySelector('[aria-busy="true"]'), `${name}: the content is marked busy`);
  }
});

test("no loading screen exposes an empty list of rows", async () => {
  for (const [name, element] of Object.entries(await skeletons())) {
    const dom = new JSDOM(`<body>${renderToStaticMarkup(element)}</body>`);
    for (const list of dom.window.document.querySelectorAll("ul, ol")) {
      assert.ok(list.closest('[aria-hidden="true"]'), `${name}: a placeholder list is hidden as a whole`);
    }
  }
});
