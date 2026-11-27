// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { visibleText } from "./add/banned-copy.ts";
import { SourcesLoadingSkeleton } from "./sources-loading-skeleton.tsx";

Object.assign(globalThis, { React });

// Phone walk: the loading screen shows the page's own header, then plain rows, not a wide table.
test("the Data sources loading screen has the page's header and one row per data source, with no table columns", () => {
  const html = renderToStaticMarkup(createElement(SourcesLoadingSkeleton));
  assert.match(html, /<h1[^>]*>Data sources<\/h1>/);
  assert.match(visibleText(html), /Add a data source/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Loading data sources…/);
  assert.doesNotMatch(html, /w-24 shrink-0|h-7 w-20 shrink-0/, "no wide column bars beside each row");
});
