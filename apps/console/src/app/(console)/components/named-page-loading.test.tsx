// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NamedPageLoadingSkeleton } from "./named-page-loading.tsx";

Object.assign(globalThis, { React });

test("a named loading screen has the page's trail, its title and its own name for screen readers", () => {
  const html = renderToStaticMarkup(createElement(NamedPageLoadingSkeleton, { breadcrumbs: [{ href: "/settings", label: "Settings" }, { label: "Tokens for scripts and tools" }], label: "tokens", shape: "list", title: "Tokens for scripts and tools" }));
  assert.match(html, /aria-label="Breadcrumb"/);
  assert.match(html, />Settings</);
  assert.match(html, /<h1[^>]*>Tokens for scripts and tools<\/h1>/);
  assert.match(html, /Loading tokens…/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /grants|device exporters|event subscriptions|deployment status/);
});

test("each shape draws the rows its page shows", () => {
  for (const shape of ["rows", "list", "form", "text"] as const) {
    const html = renderToStaticMarkup(createElement(NamedPageLoadingSkeleton, { label: "x", shape, title: "X" }));
    assert.match(html, /animate-pulse/, shape);
  }
});
