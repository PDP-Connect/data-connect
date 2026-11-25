// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as navigation from "next/navigation";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bannedCopyProblems } from "./banned-copy.ts";
import { ALL_ENTRIES, installed, notInstalled } from "./add-flow-fixtures.ts";
import { buildAddSourceList } from "./add-source-list-model.ts";
import { connectorLookupKey } from "../../lib/connector-install-presentation.ts";

Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", {
  namedExports: { ...navigation, useRouter: () => ({ refresh() {}, replace() {}, push() {} }) },
});

const listModule = import("./add-source-list.tsx");

const lifecycles = {
  amazon: notInstalled("amazon"),
  "apple-health": installed("apple-health"),
  chase: notInstalled("chase"),
  "claude-code": notInstalled("claude-code"),
  whoop: notInstalled("whoop"),
  ynab: notInstalled("ynab"),
};

const model = buildAddSourceList({
  catalog: ALL_ENTRIES,
  catalogTransientlyUnavailable: false,
  existingConnectionCounts: { amazon: 1 },
  lifecycleFor: (entry) => lifecycles[connectorLookupKey(entry.connectorKey) as keyof typeof lifecycles] ?? { catalog: null, installed: null },
});

function assertClean(html: string, label: string) {
  assert.deepEqual(bannedCopyProblems(html), [], `banned copy on "${label}"`);
}

// Design "Banned on these pages": every state of /sources/add.
test("the list page, in every state, uses none of the banned words, badges or folds", async () => {
  const { AddSourceList, AddSourceListSkeleton, AddSourceLoadFailed } = await listModule;
  const states: Array<[string, string]> = [
    ["rows", renderToStaticMarkup(createElement(AddSourceList, { model, query: "" }))],
    ["search hit", renderToStaticMarkup(createElement(AddSourceList, { model, query: "ama" }))],
    ["service that cannot be added", renderToStaticMarkup(createElement(AddSourceList, { model, query: "whoop" }))],
    ["no match", renderToStaticMarkup(createElement(AddSourceList, { model, query: "zzz" }))],
    ["loading", renderToStaticMarkup(createElement(AddSourceListSkeleton))],
    ["load failed", renderToStaticMarkup(createElement(AddSourceLoadFailed))],
  ];
  for (const [label, html] of states) assertClean(html, label);
});

// Design "Page 1": each row is the logo and name; "Added" is the only extra.
test("a row shows the name once and Added only for a service that has an account", async () => {
  const { AddSourceList } = await listModule;
  const html = renderToStaticMarkup(createElement(AddSourceList, { model, query: "" }));
  assert.equal((html.match(/>Added</g) ?? []).length, 1);
  assert.equal((html.match(/>Amazon</g) ?? []).length, 1);
  assert.doesNotMatch(html, />WHOOP</);
  assert.doesNotMatch(html, /<button/);
});

test("the checker itself catches a fold, a badge and a banned word", () => {
  assert.ok(bannedCopyProblems("<details><summary>Details</summary>x</details>").length > 0);
  assert.ok(bannedCopyProblems("<span>Experimental</span>").length > 0);
  assert.ok(bannedCopyProblems("<p>Install package first</p>").length >= 2);
  assert.deepEqual(bannedCopyProblems("<details><summary>What went wrong</summary>x</details>"), []);
});
