// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppAccessList } from "./app-access-list.tsx";
import { buildAppPractice } from "./app-practice.ts";
test("whole app rows open the app, name its data, and have no actions menu", () => {
  const html = renderToStaticMarkup(React.createElement(AppAccessList, { apps: buildAppPractice("one").apps }));
  assert.match(html, /ChatGPT/); assert.match(html, /Can read Gmail/); assert.match(html, /Last read/); assert.match(html, /href="\/grants\/practice-access"/); assert.doesNotMatch(html, /More actions/);
});
test("stopped rows do not promise present access", () => {
  const apps = buildAppPractice("one").apps; for (const app of apps) { app.state = "stopped"; app.stoppedReason = "removed"; }
  const html = renderToStaticMarkup(React.createElement(AppAccessList, { apps, stopped: true }));
  assert.match(html, /Removed/); assert.doesNotMatch(html, /Can read|Last read/);
});
