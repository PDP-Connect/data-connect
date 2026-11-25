// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { DeveloperModeGate } from "./developer-mode-gate.tsx";

const HERE = fileURLToPath(new URL(".", import.meta.url));

test("developer tool is hidden until Developer mode is on and links to its setting", () => {
  const html = renderToStaticMarkup(React.createElement(DeveloperModeGate, { children: React.createElement("span", null, "Developer controls") }));
  // RAISE-RULES 1: the request tool is available only behind Developer mode.
  assert.match(html, /This page is for developers/);
  assert.match(html, /href="\/settings#developer-mode"/);
  assert.doesNotMatch(html, /Developer controls/);
});

test("request tool actions require confirmation before approval or denial", async () => {
  const page = await readFile(`${HERE}request/page.tsx`, "utf8");
  const actions = await readFile(`${HERE}request/actions.ts`, "utf8");
  // RAISE-RULES 5: approval and denial each name their effect before the action.
  assert.match(page, /decision_confirmation/);
  assert.match(page, /lets the app read the requested data/);
  assert.match(page, /will not get access to the requested data/);
  assert.match(actions, /decision_confirmation/);
  assert.match(page, /<DeveloperModeGate>/);
});

test("developer request errors keep raw details folded", async () => {
  const page = await readFile(`${HERE}request/page.tsx`, "utf8");
  const error = page.slice(page.indexOf("function WorkspaceError"), page.indexOf("const ACCESS_MODE_OPTIONS"));
  // RAISE-RULES 4: raw server error text is available only inside folded Details.
  assert.match(error, /The request could not be completed\./);
  assert.match(error, /<details[\s\S]*<p className="break-words text-muted-foreground">\{message\}<\/p>[\s\S]*<\/details>/);
  assert.doesNotMatch(error.slice(0, error.indexOf("<details")), /\{message\}/);
});
