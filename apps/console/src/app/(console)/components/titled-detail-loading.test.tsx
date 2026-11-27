// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TitledDetailLoadingSkeleton } from "./titled-detail-loading.tsx";

Object.assign(globalThis, { React });

// L6: the loading screen has the page's trail and a title bar where the title lands.
test("the source page loading screen has its trail and a title block, and names its page", () => {
  const html = renderToStaticMarkup(createElement(TitledDetailLoadingSkeleton, { breadcrumbs: [{ href: "/sources", label: "Data sources" }], label: "this data source", mark: true }));
  assert.match(html, /aria-label="Breadcrumb"/);
  assert.match(html, />Data sources</);
  assert.match(html, /<h1[^>]*>/);
  assert.match(html, /size-12/, "an icon-sized block before the name, as on the page");
  assert.match(html, /Loading this data source…/);
  assert.match(html, /aria-busy="true"/);
});

test("the run page loading screen has the Sync history trail and a title block", () => {
  const html = renderToStaticMarkup(createElement(TitledDetailLoadingSkeleton, { breadcrumbs: [{ href: "/syncs", label: "Sync history" }], label: "this run", mark: true }));
  assert.match(html, />Sync history</);
  assert.match(html, /<h1[^>]*>/);
  assert.match(html, /Loading this run…/);
});
