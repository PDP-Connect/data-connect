// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const OVERVIEW_FILE = `${HERE}components/views/standing-overview.tsx`;
const MODEL_FILE = `${HERE}components/views/standing-view-model.ts`;
const LOADING_FILE = `${HERE}loading.tsx`;

const STANDING_OVERVIEW_RENDER = /<StandingOverview\b/;
const HOME_READS =
  /listGrants\(\{ limit: HOME_GRANT_LIMIT \}\)[\s\S]*listTraces\(\{ limit: 6 \}\)[\s\S]*listPendingApprovals\(\)[\s\S]*listOwnerIssuedClients\(\)/;
const BOUNDED_SOURCE_READ =
  /loadConnectorSummaryPage\(pageState,[\s\S]*listConnectorSummaries\(\{ \.\.\.opts, includeFleetHealth: false \}\)/;
const SOFT_READS = /function safeRead[\s\S]*rethrowControlFlow\(err\)[\s\S]*return \{ issue, value: fallback \}/;
const NO_RETIRED_READS = /getFleetHealthVerdict|getGrantPackageCount|listWebPushSubscriptions/;
const STATUS_ATTRS = /data-source-id=\{[^}]+\} data-status-row=\{[^}]+\}/;
const SOURCE_STATUS_PRIMITIVE = /<SourceStatusText/;
const ERROR_WORDS = /This could not be loaded\.[\s\S]*Try again/;
// JSX text may wrap across lines; any run of whitespace renders as one space.
const FIRST_RUN_COPY = new RegExp(
  "DataConnect keeps a copy of your own data on a computer you choose and shows how current it is. Later you choose which apps and assistants may read it."
    .replaceAll(".", "\\.")
    .replaceAll(" ", "\\s+"),
);
const FIRST_RUN_LOGOS = /\["amazon", "facebook", "gmail", "notion", "spotify"\]/;
const FIRST_SYNC_ACTION = /need\.status\?\.action\?\.kind === "retry_first_sync"[\s\S]*<SyncNowButton/;

test("Home uses the existing reads, limits, and soft-failure boundary", async () => {
  const page = await readFile(PAGE_FILE, "utf8");

  // DIRECTION.md, Home § Reads: the requested route still composes the new pure view model.
  assert.match(page, STANDING_OVERVIEW_RENDER);
  // DIRECTION.md, Home § Reads: permissions and recent reads keep their existing bounds.
  assert.match(page, HOME_READS);
  // DIRECTION.md, Home § Reads: source summaries remain one bounded page and do not fetch an aggregate verdict.
  assert.match(page, BOUNDED_SOURCE_READ);
  // DIRECTION.md, Home § Read failures: reads retain a soft fallback and rethrow control flow.
  assert.match(page, SOFT_READS);
  // DIRECTION.md, Home § Server warning: the Home title no longer depends on fleet or deployment summary reads.
  assert.doesNotMatch(page, NO_RETIRED_READS);
});

test("Home renders Needs you, Data sources, then Apps that can read your data", async () => {
  const overview = await readFile(OVERVIEW_FILE, "utf8");
  const needs = overview.indexOf("Needs you");
  const sources = overview.indexOf("Data sources");
  const apps = overview.indexOf("Apps that can read your data");

  // DIRECTION.md, Home § Page order: the page leads with the items that need the person.
  assert.ok(needs >= 0 && needs < sources);
  // DIRECTION.md, Home § Page order: data sources follow Needs you.
  assert.ok(sources < apps);
  // DIRECTION.md, Home § Data sources: status words use the shared component and carry row/source attributes.
  assert.match(overview, SOURCE_STATUS_PRIMITIVE);
  // DIRECTION.md, Home § Data sources: every rendered status can be compared to the server row.
  assert.match(overview, STATUS_ATTRS);
  // DIRECTION.md, Home § Read failures: the affected section offers the exact retry copy.
  assert.match(overview, ERROR_WORDS);
  // DIRECTION.md, Home § Needs you: retry-first-sync uses the existing sync action.
  assert.match(overview, FIRST_SYNC_ACTION);
  // DIRECTION.md, Home § Apps: retain the access package destination in the Apps section.
  assert.match(overview, /href=\{data\.packagesHref\}\s*>\s*Packages/);
});

test("first run uses bundled marks and copy that does not guess the installation host", async () => {
  const overview = await readFile(OVERVIEW_FILE, "utf8");

  // DIRECTION.md, Home § First run: the setup sentence uses the safe computer-you-choose wording.
  assert.match(overview, FIRST_RUN_COPY);
  // DIRECTION.md, Home § First run: the visible logo row uses five bundled source identities.
  assert.match(overview, FIRST_RUN_LOGOS);
  // DIRECTION.md, Home § First run: the only setup button opens source setup.
  assert.match(overview, /Add a data source[\s\S]*href=\{data\.addSourceHref\}/);
});

test("the page keeps the seeded demos and route-level loading skeleton", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  const model = await readFile(MODEL_FILE, "utf8");
  const loading = await readFile(LOADING_FILE, "utf8");

  // DIRECTION.md, Home § Demo: demos remain gated to non-production requests.
  assert.match(page, /process\.env\.NODE_ENV !== "production"/);
  // DIRECTION.md, Home § Demo: calm, alarm and decide fixtures share the live Home input shape.
  assert.match(model, /export interface HomeInputs/);
  // DIRECTION.md, Home § Loading: Home uses the shared shell and route skeleton.
  assert.match(loading, /RecordroomShellWithPalette[\s\S]*ListLoadingSkeleton/);
});
