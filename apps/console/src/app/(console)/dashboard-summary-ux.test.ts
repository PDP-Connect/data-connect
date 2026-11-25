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
const SYNC_CONTROL = /SyncNowButton|runConnectorNowAction/;
const NEED_ACTION_LINK = /className=\{`\$\{OUTLINED_BUTTON\}[^`]*`\}\s*href=\{need\.actionHref\}\s*>\s*\{need\.actionLabel\}/;
const NEEDS_BOX_STRONG_LINE = /home-needs-heading[\s\S]*rounded-md border border-border-strong/;

test("Home uses the existing reads, limits, and soft-failure boundary", async () => {
  const page = await readFile(PAGE_FILE, "utf8");

  // DIRECTION.md, Home: the requested route still composes the new pure view model.
  assert.match(page, STANDING_OVERVIEW_RENDER);
  // DIRECTION.md, Home: permissions and recent reads keep their existing bounds.
  assert.match(page, HOME_READS);
  // DIRECTION.md, Home: source summaries remain one bounded page and do not fetch an aggregate verdict.
  assert.match(page, BOUNDED_SOURCE_READ);
  // DIRECTION.md, Home: reads retain a soft fallback and rethrow control flow.
  assert.match(page, SOFT_READS);
  // DIRECTION.md, Home: the Home title no longer depends on fleet or deployment summary reads.
  assert.doesNotMatch(page, NO_RETIRED_READS);
});

test("Home renders Needs you, Data sources, then Apps that can read your data", async () => {
  const overview = await readFile(OVERVIEW_FILE, "utf8");
  const needs = overview.indexOf("Needs you");
  const sources = overview.indexOf("Data sources");
  const apps = overview.indexOf("Apps that can read your data");

  // DIRECTION.md, Home: the page leads with the items that need the person.
  assert.ok(needs >= 0 && needs < sources);
  // DIRECTION.md, Home: data sources follow Needs you.
  assert.ok(sources < apps);
  // DIRECTION.md, Home § Data sources: status words use the shared component and carry row/source attributes.
  assert.match(overview, SOURCE_STATUS_PRIMITIVE);
  // DIRECTION.md, Home § Data sources: every rendered status can be compared to the server row.
  assert.match(overview, STATUS_ATTRS);
  // DIRECTION.md, Home: the affected section offers the exact retry copy.
  assert.match(overview, ERROR_WORDS);
  // Lead decision (deputy-fixes-1 E3): no sync starts from Home; every row action opens the data source's page.
  assert.doesNotMatch(overview, SYNC_CONTROL);
  // Lead decision (home-pictures 3): every button in the needs-you box is outlined.
  assert.match(overview, NEED_ACTION_LINK);
  // Lead decision (deputy-fixes-1 E2): the packages list is linked from /grants, not Home.
  assert.doesNotMatch(overview, /Packages/);
  // DIRECTION.md, Values: the needs-you box uses the "Stronger line (buttons, the needs-you box)".
  assert.match(overview, NEEDS_BOX_STRONG_LINE);
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

  // DIRECTION.md, PAGE-RULES 8 (seeded demos): demos remain gated to non-production requests.
  assert.match(page, /process\.env\.NODE_ENV !== "production"/);
  // DIRECTION.md, PAGE-RULES 8 (seeded demos): calm, alarm and decide fixtures share the live Home input shape.
  assert.match(model, /export interface HomeInputs/);
  // DIRECTION.md, Home: Home uses the shared shell and route skeleton.
  // Lead decision (deputy-fixes-1 E1): the shared loading state is a neutral heading and plain rows, not Home's layout.
  assert.match(loading, /RecordroomShellWithPalette[\s\S]*<PageLoadingSkeleton label="this page" rows=\{4\} \/>/);
  assert.doesNotMatch(loading, /ListLoadingSkeleton/);
});
