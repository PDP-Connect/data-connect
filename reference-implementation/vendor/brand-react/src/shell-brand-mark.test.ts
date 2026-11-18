// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every DataConnect mark defines its own gradient id, and the mark has an edge on
 * the dark surface.
 *
 * Walkthrough 2026-10-23, item A11: the sidebar, header and drawer each render the
 * mark. A fixed gradient id made the header's `url(#…)` resolve to the sidebar copy,
 * which is `display: none` at 860 px and below, so the header showed only the white
 * glyphs. The navy tile also fades into the dark sidebar at its lower edge. Server
 * rendering is enough for the ids, which are attributes; the edge is pinned in CSS.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const SHELL_CSS_FILE = fileURLToPath(new URL("./shell.css", import.meta.url));
const GRADIENT_ID_RE = /<linearGradient id="([^"]+)"/g;

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} must exist in shell.css`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("the sidebar and header marks each define their own gradient id, so each paints", async () => {
  const { RecordroomShell } = await import("./shell-frame.tsx");
  const html = renderToStaticMarkup(
    createElement(
      PathnameContext.Provider,
      { value: "/explore" },
      createElement(RecordroomShell, null, createElement("p", null, "Content"))
    )
  );
  const ids = [...html.matchAll(GRADIENT_ID_RE)].map((match) => match[1]);
  assert.equal(ids.length, 2, "the sidebar and the header each render one mark");
  assert.equal(new Set(ids).size, ids.length, `gradient ids must be unique, got ${ids.join(", ")}`);
  for (const id of ids) {
    assert.ok(html.includes(`url(#${id})`), `the mark must fill with its own gradient ${id}`);
  }
});

test("the mark's edge ring is drawn on the dark surface only", async () => {
  const css = await readFile(SHELL_CSS_FILE, "utf8");
  const rule = ruleBody(css, '[data-theme="dark"] .rr-side__mark-edge');
  assert.match(rule, /\bstroke:\s*(?!none\b|transparent\b)/, "the dark theme must give the mark an edge");
});
