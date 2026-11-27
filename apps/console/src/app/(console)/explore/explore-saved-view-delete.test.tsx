// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// RAISE-RULES 5: deleting a saved view asks once and names what will happen.
// Explore brief decision 3: a selected data source row carries a check.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SAVED_VIEWS_STORAGE_KEY } from "./explore-saved-views.ts";

// The canvas import graph reaches `server-only`, which throws outside a server bundle.
mock.module("server-only", { namedExports: {} });
// Components compiled for Next's automatic runtime expect a global React here.
(globalThis as Record<string, unknown>).React = React;

const VIEW_HREF = "/explore?q=lunch";

async function mountSavedViews() {
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: `http://localhost${VIEW_HREF}` });
  const globals = globalThis as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify([{ href: VIEW_HREF, id: "v1", name: "Lunch" }]));
  const { SavedViewTabs } = await import("./explore-canvas.tsx");
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SavedViewTabs, { allHref: "/explore", currentHref: VIEW_HREF, onNavigate: () => undefined }));
  });
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
  const stored = () => JSON.parse(dom.window.localStorage.getItem(SAVED_VIEWS_STORAGE_KEY) ?? "[]") as unknown[];
  return { button, container, root, stored };
}

test("saved view Delete asks first; Cancel keeps the view, Delete view removes it", async () => {
  const { button, container, root, stored } = await mountSavedViews();

  await act(async () => button("Delete saved view Lunch")?.click());
  assert.equal(stored().length, 1, "the first press only asks");
  assert.match(container.textContent ?? "", /This removes the saved view “Lunch” from this browser\./);

  await act(async () => button("Cancel")?.click());
  assert.equal(stored().length, 1);
  assert.ok(button("Delete saved view Lunch"), "Cancel returns to the plain Delete button");

  await act(async () => button("Delete saved view Lunch")?.click());
  await act(async () => button("Delete view")?.click());
  assert.equal(stored().length, 0);

  await act(async () => root.unmount());
});

test("a selected data source row shows a check; an unselected one does not", async () => {
  const { FacetRow } = await import("./explore-canvas.tsx");
  const row = (on: boolean) =>
    renderToStaticMarkup(
      createElement(FacetRow, { count: 3, excluded: false, label: "Mail", on, onToggle: () => undefined, onToggleExclude: () => undefined })
    );
  assert.match(row(true), /rr-x-facet__check">✓</);
  assert.doesNotMatch(row(false), /✓/);
});
