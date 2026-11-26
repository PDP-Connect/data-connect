// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDemoInputs } from "./standing-demo-data.ts";
import { StandingOverview } from "./standing-overview.tsx";
import { buildHomeViewModel } from "./standing-view-model.ts";

const PRACTICE_APP_0_RE = /Practice app 0/;
const PRACTICE_APP_2_RE = /Practice app 2/;
const PRACTICE_APP_3_PRIVATE_SOURCE_NAME_RE = /Practice app 3|Private source name/;
const AND_5_MORE_RE = /and 5 more/;
const HAS_NOT_READ_ANYTHING_YET_RE = /Has not read anything yet/;
const EIGHT_APPS_CAN_READ_YOUR_DATA_RE = /8 apps can read your data/;

Object.assign(globalThis, { React });
test("Home shows three app names and reading times, then links to the remaining apps", () => {
  const hrefs = {
    addSource: "/sources/add",
    connect: "/connect",
    deployment: "/deployment",
    deploymentTokens: "/deployment/tokens",
    grant: (id: string) => `/grants/${id}`,
    grants: "/grants",
    source: (id: string) => `/sources/${id}`,
    sources: "/sources",
  };
  const data = buildHomeViewModel(buildDemoInputs("calm", hrefs));
  data.apps = Array.from({ length: 8 }, (_, index) => ({
    id: `app-${index}`,
    clientId: `app-${index}`,
    href: `/grants/app-${index}`,
    name: `Practice app ${index}`,
    reads: "Private source name",
    lastRead: index === 0 ? null : `${index} hours ago`,
  }));
  const html = renderToStaticMarkup(React.createElement(StandingOverview, { data }));
  assert.match(html, PRACTICE_APP_0_RE);
  assert.match(html, PRACTICE_APP_2_RE);
  assert.doesNotMatch(html, PRACTICE_APP_3_PRIVATE_SOURCE_NAME_RE);
  assert.match(html, AND_5_MORE_RE);
  assert.match(html, HAS_NOT_READ_ANYTHING_YET_RE);
  assert.match(html, EIGHT_APPS_CAN_READ_YOUR_DATA_RE);
});
