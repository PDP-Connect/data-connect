// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCES = `${HERE}../../sources/`;
const RECORDS_ADD_PAGE_FILE = `${SOURCES}add/page.tsx`;
const ROUTES_FILE = fileURLToPath(new URL("../../../../../../../reference-implementation/vendor/operator-ui/src/components/views/routes.ts", import.meta.url));
const SHELL_FILE = fileURLToPath(new URL("../../../../../../../reference-implementation/vendor/brand-react/src/shell-frame.tsx", import.meta.url));
const CONNECT_PAGE_FILE = `${HERE}../../connect/page.tsx`;
const SOURCE_SETUP_CATALOG_FILE = `${HERE}../source-setup-catalog.tsx`;
const ADD_SUPPORT_FILE = `${HERE}../../lib/source-add-support.ts`;
const SOURCE_SETUP_PRESENTATION_FILE = `${HERE}../../lib/source-setup-presentation.ts`;
const SOURCE_GROUPS_FILE = `${HERE}../../lib/source-groups.ts`;
const HERO_FILE = fileURLToPath(new URL("../../../../../../../reference-implementation/vendor/operator-ui/src/components/overview-hero.tsx", import.meta.url));
const ROUTES_ADD_SOURCE_RE = /addSource: `\$\{basePath\}\/\$\{seg\.records\}\/add`/;
const SOURCE_ACTIONABILITY_PROJECTION_RE = /const actionability = projectSourceActionability\(summary\)/;
const RENDERED_VERDICT_STATUS_RE = /const status = actionability\.renderedStatus/;
const RENDERED_VERDICT_PRIMARY_ACTION_RE = /const \{ primaryVerdictAction \} = actionability/;
const RENDERED_VERDICT_NEXT_ACTION_RE = /actionability\.nextAction/;
const INSPECTION_LAYER_FIELDS_RE = /detail_gap_backlog|next_attempt_at|collection_rate|suppressed/;
const RUNTIME_ADVISORY_MODEL_RE = /buildSourcesRuntimeAdvisory\(page\.runtime\)/;
const RUNTIME_ADVISORY_PROP_RE = /runtimeAdvisory=\{runtimeAdvisory\}/;
const RUNTIME_ADVISORY_RENDER_RE = /data-testid="sources-runtime-advisory"/;
const LIST_CONNECTOR_MANIFESTS_RE = /listConnectorManifests\(\)/;
const LIST_OWNER_CONNECTOR_TEMPLATES_RE = /listOwnerConnectorTemplates\(\)/;
const BUILD_CONNECTOR_CATALOG_RE = /buildOwnerConnectorCatalog\(manifests, templates, installSnapshot\?\.catalog \?\? \[\]\)/;
const SOURCE_SETUP_CATALOG_RE = /<SourceSetupCatalog/;
const SOURCE_SETUP_SECTION_RE = /title="Add data"/;
const SOURCE_SEARCH_RE = /name="source_q"[\s\S]*?Search source name or connector key/;
const SOURCE_CARD_RE = /data-testid=\{`source-setup-\$\{entry\.connectorKey\}`\}/;
const SOURCE_ACQUISITION_PATHS_RE = /data-testid="source-acquisition-paths"/;
const SOURCE_ACQUISITION_PATH_RE = /data-testid="source-acquisition-path"/;
const OTHER_COVERAGE_PATHS_RE = /Other ways to add data/;
const IMPORT_OPTIONS_DISCLOSURE_RE = /Show import options/;
const GENERIC_WHY_THIS_RE = /Why this, and what to expect/;
const SOURCE_PROVIDER_SPECIFIC_COPY_RE = /\b(Amazon|Gmail|GitHub|Slack|ChatGPT|Chase|Notion|Spotify)\b|app password|personal access token/i;
const FORBIDDEN_DEV_STRINGS_RE = /pnpm --dir|packages\/[a-z]|PDPP monorepo checkout|env var per account|pdpp owner-agent connectors|connector_instance_id|source_instance_id|device_token/;
const NAV_SOURCES_RE = /\{\s*label: "Data sources",\s*href: "\/sources"/;
const NAV_APPS_RE = /\{\s*label: "Apps",\s*href: "\/grants"/;
const NAV_CONNECT_APP_CHILD_RE = /\{ label: "Connect an app", href: "\/connect" \}/;
const CONNECT_PAGE_TITLE_RE = /title="Connect an app"/;
// The heading subtitle left (it used banned words); the "Need more data first?" note now points setup to Sources.
const CONNECT_PAGE_SETUP_POINTER_RE = /href=\{dashboardRoutes\.section\.addSource\}[\s\S]*?title="Need more data first\?"/;

async function sourceFile(name: string): Promise<string> {
  return readFile(`${SOURCES}${name}`, "utf8");
}

// DIRECTION.md, “Data sources /sources”: title, empty state, add action, and the named empty update slot.
test("Sources header and empty state use the specified copy and route", async () => {
  const [page, view] = await Promise.all([sourceFile("page.tsx"), sourceFile("sources-view.tsx")]);
  assert.match(page, /Data sources/);
  assert.match(page, /href=\{`\$\{SOURCES_PATH\}\/add`\}>Add a data source/);
  assert.match(view, /No data sources yet\./);
  // DIRECTION.md, “Data sources /sources”: only a truly empty first page uses the all-data-sources empty state.
  assert.match(view, /instances\.length === 0 && !pagingInPlay/);
  assert.match(view, /No data sources on this page\./);
  // DIRECTION.md, “Data sources /sources”: the separate update line uses an empty Suspense fallback.
  assert.match(view, /<Suspense fallback=\{null\}>[\s\S]*<UpdatesReadySlot/);
});

// DIRECTION.md, “Data sources /sources”: controls L1–L21 stay on the list, menu, pager, or source page.
test("each existing list control L1–L21 still has a visible destination", async () => {
  const [view, page, model, sourcePage] = await Promise.all([
    sourceFile("sources-view.tsx"),
    sourceFile("page.tsx"),
    sourceFile("sources-view-model.ts"),
    readFile(`${SOURCES}[connector]/page.tsx`, "utf8"),
  ]);
  const evidence: Array<[string, RegExp]> = [
    ["L1/L2 add source", /Add a data source/],
    ["L3 duplicate review", /Review duplicate data source labels/],
    ["L4 duplicate rows", /buildDuplicateSourceReview|instance\.needsOwnerLabel/],
    ["L5 disconnected group", /label="Disconnected"/],
    ["L6 archived group", /label="Archived"/],
    ["L7 setup group", /label="Setup never completed"/],
    ["L8 row navigation", /href=\{instance\.detailHref\}/],
    ["L9 copyable id", /ariaLabel="Copy connection ID"/],
    ["L10 source page link", /label: "Open this data source"/],
    // DIRECTION.md, “Data sources /sources”: menu copy does not expose server next-action wording.
    ["L11 next step", /statusWords\.action/],
    ["L12 sync/reprocess", /runConnectorNowAction[\s\S]*Reprocess all exports/],
    ["L13 add export", /Add another export/],
    ["L14 details", /Open this data source/],
    ["L15 revoke", /Confirm revoke/],
    ["L16 reactivate", /Reactivate resumes collection/],
    ["L17 sync link", /See this sync/],
    // DIRECTION.md, “One data source”: stream rows keep their Explore destination on the data source page.
    ["L18 explore records", /href=\{`\/sources\/\$\{encodeURIComponent\(connectionId\)\}\/\$\{encodeURIComponent\(s\.name\)\}`\}/],
    ["L19/L20 paging", /<ConnectorSummaryPager/],
    ["L21 saved-session retry", /Remove saved browser session/],
  ];
  const corpus = `${view}\n${page}\n${model}\n${sourcePage}`;
  for (const [control, pattern] of evidence) assert.match(corpus, pattern, `${control} is missing`);
  assert.match(page, /purgeRetryId/);
  assert.match(page, /SourcesHeader error=\{params\.error\} message=\{params\.message\} purgeRetryId=\{params\.purge_retry\}/);
});

// DIRECTION.md, “Data sources /sources”: the row action follows the shared table and the menu contains only remaining actions.
test("status actions use their existing handlers and the remaining actions use a real menu", async () => {
  const [view, page, model] = await Promise.all([sourceFile("sources-view.tsx"), sourceFile("page.tsx"), sourceFile("sources-view-model.ts")]);
  assert.match(view, /const action = instance\.statusWords\.action/);
  assert.match(view, /action\.filled \? "default" : "ghost"/);
  assert.match(view, /action\.kind === "resume" && instance\.connectionId[\s\S]*action=\{resumeAction\}/);
  assert.match(view, /primaryVerdictAction\?\.kind === "reattach_schedule"[\s\S]*action=\{resumeScheduleAction\}/);
  assert.match(view, /action\.kind === "continue_setup" && instance\.setupFailed[\s\S]*action=\{resumeSetupAction\}/);
  assert.match(page, /resumeAction=\{resumeConnectionAction\}/);
  assert.match(page, /resumeScheduleAction=\{resumeConnectorScheduleAction\}/);
  assert.match(page, /resumeSetupAction=\{resumeSetupConnectionAction\}/);
  assert.match(page, /runNowAction=\{runConnectorNowAction\}/);
  // DIRECTION.md, status row 3: “Set up again” keeps the detail page's existing Add address.
  assert.match(view, /action\.kind === "set_up_again"[\s\S]*source_q=\$\{encodeURIComponent\(instance\.connectorId\)\}/);
  assert.match(view, /Menu\.Trigger[\s\S]*Menu\.Popup/);
  // DIRECTION.md, “Data sources /sources”: Sync now is omitted for server actions owned by another surface.
  assert.match(model, /serverActionBelongsElsewhere[\s\S]*primaryVerdictAction !== null \|\| instance\.nextAction !== null/);
  assert.match(model, /kind: "add_export"[\s\S]*Add another export/);
  assert.match(model, /kind: "reprocess"[\s\S]*Reprocess all exports/);
  assert.match(view, /setConfirmingRevoke\(true\)/);
  assert.match(view, /setConfirmingReactivate\(true\)/);
  assert.match(view, /data-testid="sources-revoke-ceremony"/);
});

// DIRECTION.md, “Data sources /sources”: the filter stays client-side and paging/error recovery remains below it.
test("filter, notices, loading shape, and pager remain in their specified positions", async () => {
  const [view, page, loading] = await Promise.all([
    sourceFile("sources-view.tsx"),
    sourceFile("page.tsx"),
    sourceFile("loading.tsx"),
  ]);
  assert.match(view, /listRows\.length > 10/);
  assert.match(view, /onChange=\{\(event\) => setQuery/);
  // DIRECTION.md, “What must stay true” item 2: the note counts the rows the filter searches, not the folded ones.
  assert.match(view, /Filtering the \{listRows\.length\.toLocaleString\(\)\} data sources on this page\./);
  assert.match(page, /error && purgeRetryId/);
  assert.match(view, /sources-runtime-advisory/);
  assert.match(view, /sources-duplicate-review/);
  assert.match(page, /ConnectorSummaryPager/);
  // DIRECTION.md, “Data sources /sources”: loading uses the title-and-rows list shape.
  assert.match(loading, /ListLoadingSkeleton label="data sources" rows=\{6\}/);
});

test("blank overview still offers the existing Add a data source route", async () => {
  const [hero, routes] = await Promise.all([readFile(HERO_FILE, "utf8"), readFile(ROUTES_FILE, "utf8")]);
  assert.ok(hero.includes("addSourceHref"));
  assert.ok(hero.includes("Add a data source"));
  assert.ok(!hero.includes("Start a grant to begin ingesting"));
  assert.match(routes, ROUTES_ADD_SOURCE_RE);
});

test("the source setup catalog remains on the Add page", async () => {
  const [page, catalog] = await Promise.all([
    readFile(RECORDS_ADD_PAGE_FILE, "utf8"),
    readFile(SOURCE_SETUP_CATALOG_FILE, "utf8"),
  ]);
  assert.match(page, LIST_CONNECTOR_MANIFESTS_RE);
  assert.match(page, LIST_OWNER_CONNECTOR_TEMPLATES_RE);
  assert.match(page, BUILD_CONNECTOR_CATALOG_RE);
  assert.match(page, SOURCE_SETUP_CATALOG_RE);
  assert.match(catalog, SOURCE_SETUP_SECTION_RE);
  assert.match(catalog, SOURCE_SEARCH_RE);
  assert.match(catalog, SOURCE_CARD_RE);
  assert.match(catalog, SOURCE_ACQUISITION_PATHS_RE);
  assert.match(catalog, SOURCE_ACQUISITION_PATH_RE);
  assert.match(catalog, OTHER_COVERAGE_PATHS_RE);
  assert.match(catalog, IMPORT_OPTIONS_DISCLOSURE_RE);
  assert.doesNotMatch(catalog, GENERIC_WHY_THIS_RE);
});

test("Sources still projects summary actionability without putting diagnostics on the list", async () => {
  const [model, view] = await Promise.all([
    sourceFile("sources-view-model.ts"),
    sourceFile("sources-view.tsx"),
  ]);
  assert.match(model, SOURCE_ACTIONABILITY_PROJECTION_RE);
  assert.match(model, RENDERED_VERDICT_STATUS_RE);
  assert.match(model, RENDERED_VERDICT_PRIMARY_ACTION_RE);
  assert.match(model, RENDERED_VERDICT_NEXT_ACTION_RE);
  assert.doesNotMatch(view, INSPECTION_LAYER_FIELDS_RE);
});

test("Sources still renders one global runtime notice from the bounded summary", async () => {
  const [page, view] = await Promise.all([
    sourceFile("page.tsx"),
    sourceFile("sources-view.tsx"),
  ]);
  assert.match(page, RUNTIME_ADVISORY_MODEL_RE);
  assert.match(page, RUNTIME_ADVISORY_PROP_RE);
  assert.match(view, RUNTIME_ADVISORY_RENDER_RE);
});

test("manual upload rows keep their import actions and existing-source route", async () => {
  const [view, model] = await Promise.all([
    sourceFile("sources-view.tsx"),
    sourceFile("sources-view-model.ts"),
  ]);
  // DIRECTION.md, “Data sources /sources”: the pure menu model supplies the existing import actions.
  assert.match(model, /label: "Add another export"/);
  assert.match(model, /label: "Reprocess all exports"/);
  assert.match(model, /instance\.manualUploadHref/);
  assert.match(model, /connection_id/);
  // DIRECTION.md, “Data sources /sources”: the menu renders the model's remaining controls.
  assert.match(view, /sourceRowMenuItems\(instance, interactive\)/);
  assert.match(model, /instance\.sourceKind !== "manual"/);
});

test("Sources keeps the summary projection separate from the Add catalog", async () => {
  const [page, view] = await Promise.all([
    sourceFile("page.tsx"),
    sourceFile("sources-view.tsx"),
  ]);
  assert.match(page, /toSourcesView/);
  assert.match(page, /<SourcesView/);
  assert.match(page, /isActiveConnectorRunSummaryStatus[\s\S]*connector-run-summary-status\.ts/);
  assert.match(page, /isActiveConnectorRunSummaryStatus\(\s*s\.last_run\.status\s*\)/);
  assert.doesNotMatch(view, /connection-catalog/);
  assert.doesNotMatch(view, /AddConnectionGuidance/);
});

test("Sources and source setup do not show developer-only strings", async () => {
  const [view, support, groups, presentation] = await Promise.all([
    sourceFile("sources-view.tsx"),
    readFile(ADD_SUPPORT_FILE, "utf8"),
    readFile(SOURCE_GROUPS_FILE, "utf8"),
    readFile(SOURCE_SETUP_PRESENTATION_FILE, "utf8"),
  ]);
  assert.doesNotMatch(view, FORBIDDEN_DEV_STRINGS_RE);
  assert.doesNotMatch(support, FORBIDDEN_DEV_STRINGS_RE);
  assert.doesNotMatch(groups, FORBIDDEN_DEV_STRINGS_RE);
  assert.doesNotMatch(presentation, SOURCE_PROVIDER_SPECIFIC_COPY_RE);
  assert.doesNotMatch(presentation, FORBIDDEN_DEV_STRINGS_RE);
});

// DIRECTION.md, shared shell and Connect pages: data-source setup and app read access remain separate destinations.
test("shared navigation distinguishes Data sources from app access", async () => {
  const shell = await readFile(SHELL_FILE, "utf8");
  // DIRECTION.md, “The frame and the menu”: the collection surface is Data sources and app access is under Apps.
  assert.match(shell, NAV_SOURCES_RE);
  assert.match(shell, NAV_APPS_RE);
  assert.match(shell, NAV_CONNECT_APP_CHILD_RE);
});

test("Connect apps stays a read-access page that points setup to Sources", async () => {
  const connect = await readFile(CONNECT_PAGE_FILE, "utf8");
  assert.match(connect, CONNECT_PAGE_TITLE_RE);
  assert.match(connect, CONNECT_PAGE_SETUP_POINTER_RE);
  assert.doesNotMatch(connect, LIST_CONNECTOR_MANIFESTS_RE);
  assert.doesNotMatch(connect, SOURCE_SETUP_SECTION_RE);
});
