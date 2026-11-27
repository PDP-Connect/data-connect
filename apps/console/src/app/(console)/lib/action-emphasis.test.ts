// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { actionEmphasis } from "./action-emphasis.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the needed action is filled; the optional button goes quiet only while something needs the person", () => {
  assert.deepEqual(actionEmphasis(true), { needed: "filled", optional: "quiet" });
  assert.deepEqual(actionEmphasis(false), { needed: "filled", optional: "filled" });
});

test("Home and the Data sources list take their button style from that rule", () => {
  const home = read("../components/views/standing-overview.tsx");
  assert.match(home, /actionEmphasis\(data\.needsVisible\)/);
  assert.doesNotMatch(home, /className=\{`\$\{OUTLINED_BUTTON\} col-start-2/);
  const list = read("../sources/sources-view.tsx");
  assert.match(list, /instance\.statusWords\.needsYou \? "default" : "ghost"/);
  assert.match(read("../sources/page.tsx"), /actionEmphasis\(/);
});
