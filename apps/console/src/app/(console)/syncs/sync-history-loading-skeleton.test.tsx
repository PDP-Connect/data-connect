// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { visibleText } from "../sources/add/banned-copy.ts";
import { SyncHistoryLoadingSkeleton } from "./sync-history-loading-skeleton.tsx";

Object.assign(globalThis, { React });

// Phone walk: the loading screen shows the page's own header and one-per-line filters, then rows.
test("the Sync history loading screen has the page's header, stacked filters and plain rows", () => {
  const html = renderToStaticMarkup(createElement(SyncHistoryLoadingSkeleton));
  assert.match(html, /<h1[^>]*>Sync history<\/h1>/);
  assert.match(visibleText(html), /What DataConnect did to keep your copies up to date\./);
  assert.match(html, /Loading sync history…/);
  assert.match(html, /flex-col/, "filters stack");
  assert.doesNotMatch(html, /w-24 shrink-0|h-7 w-20 shrink-0/);
});
