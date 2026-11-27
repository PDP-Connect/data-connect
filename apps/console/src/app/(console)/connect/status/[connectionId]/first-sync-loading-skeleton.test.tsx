// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstSyncLoadingSkeleton } from "./first-sync-loading-skeleton.tsx";

Object.assign(globalThis, { React });

// L6: the loading screen has the shape of the page that follows, including its trail and title block.
test("the first-sync loading screen has the trail and a title block, and names its page", () => {
  const html = renderToStaticMarkup(createElement(FirstSyncLoadingSkeleton));
  assert.match(html, /aria-label="Breadcrumb"/);
  assert.match(html, /href="\/">Home<\/a>|>Home</);
  assert.match(html, />Data sources</);
  assert.match(html, /<h1[^>]*>/, "a title block where the page's title lands");
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Loading your first sync…/);
  assert.doesNotMatch(html, /Loading this page/);
});
