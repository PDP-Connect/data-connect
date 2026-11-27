// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { DailySyncsView } from "../syncs/daily-syncs-view.tsx";
import { syncPractice } from "./practice.ts";
mock.module(new URL("../syncs/[runId]/actions.ts",import.meta.url).href, { exports: { cancelRunAction: async () => ({ok:true}), submitRunInteractionAction: async () => ({error:null,status:"success"}) } });
mock.module("next/navigation", { exports: { useRouter: () => ({ refresh() {}, replace() {} }) } });
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function page() {
  const model = syncPractice("mixed", 120);
  assert.equal(model.history.mode, "days");
  if (model.history.mode !== "days") throw new Error("wrong mode");
  return new JSDOM(renderToStaticMarkup(<DailySyncsView rows={model.history.data} sources={model.sources} current={model.now} offset={120} demo="mixed" />)).window.document;
}

// Phone walk: at 390px the filters take one line each, and the date box is as wide as its line.
test("sync history filters stack one per line on a narrow screen", () => {
  const form = page().querySelector("form");
  assert.ok(form);
  assert.match(form.className, /\bflex-col\b/);
  assert.match(form.className, /\bsm:flex-row\b/);
  const date = form.querySelector('input[type="date"]');
  assert.match(date?.className ?? "", /\bw-full\b/);
});

// Phone walk: logo and name share the first line, the time sits under the name, the facts follow.
test("a sync history row puts logo and name on one line with the time under the name", () => {
  const row = page().querySelector('a[href^="/syncs/day"]');
  assert.ok(row);
  assert.match(row.className, /\bflex-col\b/);
  const content = row.querySelector("div > div");
  assert.ok(content);
  const [name, time] = [...content.children];
  assert.equal(name?.tagName, "P");
  assert.match(time?.className ?? "", /\bsm:hidden\b/);
  assert.match(name?.parentElement?.parentElement?.className ?? "", /\bitems-start\b/);
});
