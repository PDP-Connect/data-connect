// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConsentFinished,
  ConsentScreen,
  ConsentUnavailable,
} from "../../../components/consent-screen/consent-screen-client.tsx";
import { buildConsentDemoModel } from "../../../components/consent-screen/consent-screen-demo.ts";
import { ConnectView } from "../connect/connect-page.tsx";
import { AppAccessList } from "./app-access-list.tsx";
import { APP_PRACTICE_STATES, buildAppPractice } from "./app-practice.ts";

mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh() {} }) } });
mock.module("./remove-app-action.ts", { namedExports: { removeAppAction: async () => ({ ok: true, message: null }) } });
mock.module("../lib/ref-client.ts", { namedExports: { listAppAccess: async () => ({ data: [] }) } });
const { SourceAppsList } = await import("../sources/[connector]/source-apps.tsx");
const { AppPage } = await import("./[grantId]/app-page.tsx");
Object.assign(globalThis, { React });
const action = async () => ({ ok: true as const, redirectUrl: "" });
function plain(element: React.ReactElement) {
  const dom = new JSDOM(renderToStaticMarkup(element));
  for (const node of dom.window.document.querySelectorAll("details")) {
    if (node.querySelector("summary")?.textContent === "Technical details") {
      node.remove();
    }
  }
  for (const command of dom.window.document.querySelectorAll("code")) {
    command.remove();
  }
  const text = dom.window.document.body.textContent
    ?.replaceAll("Technical details", "")
    .replaceAll("Add custom MCP server", "")
    .replaceAll("Add custom connector", "")
    .replaceAll("“/mcp”", "");
  dom.window.close();
  assert.doesNotMatch(
    text || "",
    /\b(?:grant|client|scope|OAuth|bearer|token|registration|package|trace|challenge|digest|consent|revoke|revoked|issued|active|events|state|peek|manifest|connector|operator|instance|dashboard|credential|seal|browser-backed|MCP)\b/i
  );
  assert.doesNotMatch(text || "", /Status not available|Not shown|An app(?! that gave no name)/);
  return text || "";
}
for (const state of APP_PRACTICE_STATES) {
  test(`plain, consistent app practice: ${state}`, () => {
    const { apps } = buildAppPractice(state);
    plain(React.createElement(AppAccessList, { apps: apps.filter((app) => app.state === "reading") }));
    const app = state === "app-waiting" ? apps.find((row) => row.state === "waiting") : apps[0];
    if (app) {
      plain(React.createElement(AppPage, { app, demo: state }));
    }
    if (state === "thirty") {
      assert.equal(apps.length, 1);
      assert.equal(apps[0]?.clientIds.length, 30);
      assert.equal(apps[0]?.grantIds.length, 60);
    }
    if (state === "forty") {
      assert.equal(apps.length, 40);
    }
    if (state === "five") {
      assert.equal(apps.length, 5);
    }
    if (state === "expired") {
      assert.equal(app?.state, "stopped");
    }
    if (state === "app-twelve") {
      assert.equal(app?.sourceAccess.length, 12);
    }
  });
}
for (const state of ["normal", "many", "one", "some", "verified", "not-verified", "empty", "kinds-open"] as const) {
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
    if (state === "empty") {
      assert.equal(model.sources.length, 0);
    }
  });
}
for (const kind of ["expired", "error", "answered"] as const) {
  test(`plain unavailable practice: ${kind}`, () => {
    plain(React.createElement(ConsentUnavailable, { kind }));
  });
}
for (const allowed of [true, false]) {
  test(`plain answered practice: ${allowed}`, () => {
    plain(React.createElement(ConsentFinished, { appName: "ChatGPT", allowed }));
  });
}
for (const state of ["empty", "local", "one", "several"]) {
  test(`plain Connect practice: ${state}`, () => {
    plain(
      React.createElement(ConnectView, {
        origin: state === "local" ? "http://192.168.1.50:8080" : "https://data.northwind.example",
        apps: buildAppPractice(state === "local" ? "empty" : state).apps,
      })
    );
  });
}

for (const allowed of [true, false]) {
  test(`source app section matches the exact connection: ${allowed}`, () => {
    const apps = buildAppPractice("one").apps;
    const text = plain(
      React.createElement(SourceAppsList, { apps, connectionId: allowed ? "practice-gmail" : "other-account" })
    );
    if (allowed) {
      assert.match(text, /ChatGPT/);
      assert.match(text, /since/);
    } else {
      assert.match(text, /No app can read this yet/);
    }
  });
}

test("the real-shaped practice has 56 permissions and exactly 45 source rows everywhere", () => {
  const { apps } = buildAppPractice("app-fifty-six");
  const app = apps[0]!;
  assert.equal(app.grantIds.length, 56);
  assert.equal(app.sources.length, 45);
  assert.equal(app.sourceAccess.length, 45);
  assert.equal(
    (renderToStaticMarkup(React.createElement(AppPage, { app, demo: "app-fifty-six" })).match(/<li /g) || []).length,
    45
  );
});
test("the real-shaped app list has 34 unused apps including 12 that never read", () => {
  const { apps } = buildAppPractice("forty-eight");
  assert.equal(apps.length, 48);
  assert.equal(apps.filter((app) => !app.lastRead).length, 12);
  assert.equal(
    apps.filter((app) => !app.lastRead || Date.parse(app.lastRead) < Date.now() - 30 * 86_400_000).length,
    34
  );
});
test("service-only practice folds into one account and stays an all-accounts row with three", () => {
  const one = buildAppPractice("service-one").apps[0]!;
  const three = buildAppPractice("service-three").apps[0]!;
  assert.equal(one.sources.length, 1);
  assert.equal(one.sourceAccess[0]!.active_grant_ids.length, 2);
  assert.equal(three.sources.length, 2);
  assert.ok(three.sources.includes("All Gmail accounts"));
});

test("an app with no reads says so in its recent-reading section", async()=>{
 const {RecentReading}=await import("./[grantId]/recent-reading.tsx");
 const html=renderToStaticMarkup(React.createElement(RecentReading,{rows:[],sources:[],offset:0}));
 assert.match(html,/What it has read lately/);assert.match(html,/It has not read anything yet\./);
});
test("app and history practice authorize the same sources and reading clocks",async()=>{
 const {practiceHistoryApps,groupAppHistory}=await import("../history/history-apps.ts");
 const {historyPracticeSources}=await import("../history/practice.ts");
 const loaded=buildAppPractice("mixed");const app=loaded.apps[0]!;
 assert.deepEqual(app.sourceAccess.map(source=>source.source.connection_id).sort(),practiceHistoryApps("mixed")[0]!.sourceAccess.map(source=>source.source.connection_id).sort());
 assert.equal(loaded.readingHistory.mode,"days");if(loaded.readingHistory.mode!=="days")throw Error("mode");
 const rows=groupAppHistory(loaded.readingHistory.data,[app]);
 assert.equal(app.lastRead,rows[0]!.last_at);
 for(const source of app.sourceAccess)assert.equal(source.last_read_at,rows[0]!.sources.find(read=>read.connection_id===source.source.connection_id)?.last_at);
 const html=renderToStaticMarkup(React.createElement(AppPage,{app,recent:{rows,sources:historyPracticeSources(),offset:0}}));
 const list=renderToStaticMarkup(React.createElement(AppAccessList,{apps:[app]}));
 assert.ok(html.includes("Last read"));assert.ok(list.includes("Last read"));
 assert.ok(html.includes("What it has read lately"));
});
