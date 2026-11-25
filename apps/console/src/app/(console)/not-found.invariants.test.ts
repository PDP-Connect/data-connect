// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The console not-found page renders inside the shared frame with one
 * heading and one way back to Home.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

Object.assign(globalThis, { React });

mock.module(new URL("./components/recordroom-shell-with-palette.tsx", import.meta.url).href, {
  namedExports: {
    RecordroomShellWithPalette: ({ children }: { children: ReactNode }) =>
      createElement("div", { "data-frame": "shell" }, children),
  },
});

test("a missing console page renders inside the frame with one heading and a link to Home", async () => {
  const { default: ConsoleNotFound } = await import("./not-found.tsx");
  const html = renderToStaticMarkup(createElement(ConsoleNotFound));
  assert.match(html, /^<div data-frame="shell">/);
  assert.match(html, /<h1[^>]*>This page does not exist\.<\/h1>/);
  const links = html.match(/<a\b[^>]*>[^<]*<\/a>/g) ?? [];
  assert.equal(links.length, 1);
  assert.match(links[0] ?? "", /href="\/"[^>]*>Go to Home<\/a>/);
});
