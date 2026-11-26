// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { APP_PRACTICE_STATES, buildAppPractice } from "./app-practice.ts";
import { AppAccessList } from "./app-access-list.tsx";
import { ConnectView } from "../connect/connect-page.tsx";
import {
  ConsentScreen,
  ConsentUnavailable,
  ConsentFinished,
} from "../../../components/consent-screen/consent-screen-client.tsx";
import { buildConsentDemoModel } from "../../../components/consent-screen/consent-screen-demo.ts";
mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh() {} }) } });
mock.module("./remove-app-action.ts", { namedExports: { removeAppAction: async () => ({ ok: true, message: null }) } });
mock.module("../lib/ref-client.ts", { namedExports: { listAppAccess: async () => ({ data: [] }) } });
const { SourceAppsList } = await import("../sources/[connector]/source-apps.tsx");
const { AppPage } = await import("./[grantId]/app-page.tsx");
Object.assign(globalThis, { React });
const action = async () => ({ ok: true as const, redirectUrl: "" });
function plain(element: React.ReactElement) {
  const dom = new JSDOM(renderToStaticMarkup(element));
  for (const node of dom.window.document.querySelectorAll("details"))
    if (node.querySelector("summary")?.textContent === "Technical details") node.remove();
  const text = dom.window.document.body.textContent
    ?.replaceAll("Technical details", "")
    .replaceAll("Add custom MCP server", "")
    .replaceAll("Add custom connector", "");
  dom.window.close();
  assert.doesNotMatch(
    text || "",
    /\b(?:grant|client|scope|OAuth|bearer|token|registration|package|trace|challenge|digest|consent|revoke|revoked|issued|active|events|state|peek|manifest|connector|operator|instance|dashboard|credential|seal|browser-backed|MCP)\b/i
  );
  assert.doesNotMatch(text || "", /Status not available|Not shown|An app(?! that gave no name)/);
  return text || "";
}
for (const state of APP_PRACTICE_STATES)
  test(`plain, consistent app practice: ${state}`, () => {
    const { apps } = buildAppPractice(state);
    plain(React.createElement(AppAccessList, { apps: apps.filter((app) => app.state === "reading") }));
    const app = state === "app-waiting" ? apps.find((row) => row.state === "waiting") : apps[0];
    if (app) plain(React.createElement(AppPage, { app, demo: state }));
    if (state === "thirty") {
      assert.equal(apps.length, 1);
      assert.equal(apps[0]?.clientIds.length, 30);
      assert.equal(apps[0]?.grantIds.length, 60);
    }
    if (state === "forty") assert.equal(apps.length, 40);
  if (state === "five") assert.equal(apps.length, 5);
  if (state === "expired") assert.equal(app?.state, "stopped");
    if (state === "app-twelve") assert.equal(app?.sourceAccess.length, 12);
  });
for (const state of ["normal", "many", "one", "some", "verified", "not-verified", "empty", "kinds-open"] as const)
  test(`plain approval practice: ${state}`, () => {
    const model = buildConsentDemoModel(state);
    plain(
      React.createElement(ConsentScreen, {
        model,
        acceptAction: action,
        rejectAction: action,
        demoOnly: true,
        openKinds: state === "kinds-open",
      })
    );
    if (state === "empty") assert.equal(model.sources.length, 0);
  });
for (const kind of ["expired", "error", "answered"] as const)
  test(`plain unavailable practice: ${kind}`, () => {
    plain(React.createElement(ConsentUnavailable, { kind }));
  });
for (const allowed of [true, false])
  test(`plain answered practice: ${allowed}`, () => {
    plain(React.createElement(ConsentFinished, { appName: "ChatGPT", allowed }));
  });
for (const state of ["empty", "local", "one", "several"])
  test(`plain Connect practice: ${state}`, () => {
    plain(
      React.createElement(ConnectView, {
        origin: state === "local" ? "http://192.168.1.50:8080" : "https://data.northwind.example",
        apps: buildAppPractice(state === "local" ? "empty" : state).apps,
      })
    );
  });

for (const allowed of [true, false]) test(`source app section matches the exact connection: ${allowed}`, () => {
  const apps = buildAppPractice("one").apps;
  const text = plain(React.createElement(SourceAppsList, { apps, connectionId: allowed ? "practice-gmail" : "other-account" }));
  if (allowed) { assert.match(text, /ChatGPT/); assert.match(text, /since/); }
  else assert.match(text, /No app can read this yet/);
});
