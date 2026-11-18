// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the honest handling of browser-bound connector deep-links on the
 * device-exporters enrollment page.
 *
 * The Sources "Add source" catalog deep-links the supported local-collector set
 * (`?connector=claude_code`/`codex`) into this form.
 * Browser-bound sources must not be prefilled here: the old proof path required
 * a PDPP source checkout and is not an owner-usable setup flow. They render an
 * honest packaged-path-pending notice until the dashboard browser flow ships.
 *
 * These are source-text structural invariants, matching the rest of the console
 * test suite (server components have no JSX render harness here). They fail if the
 * page regresses to swallowing a browser-bound deep-link or stops routing through
 * the shared source of truth.
 *
 * See connection-modality.ts and the Sources add-source catalog.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../../../../", import.meta.url);

function read(relPath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relPath, ROOT)), "utf8");
}

const PAGE_PATH = "apps/console/src/app/(console)/device-exporters/page.tsx";

const USES_CLASSIFIER = /\bisBrowserBoundConnector\b/;
const IMPORTS_FROM_MODALITY = /from "\.\.\/lib\/connection-modality\.ts"/;
const DEFAULT_ONLY_LOCAL_COLLECTOR =
  /const defaultConnectorId = isSupportedLocalCollectorConnector\(requestedConnector\) \? requestedConnector : undefined/;
const DOES_NOT_USE_SUPPORTED_BROWSER_CLASSIFIER = /\bisSupportedBrowserCollectorConnector\b/;
const RENDERS_NOTICE = /browserBoundRequest\s*\?\s*\(?\s*<BrowserBoundEnrollmentNotice/;
const PENDING_BROWSER_TITLE = /Browser setup not available yet/;
const PACKAGED_PENDING_COPY = /Browser setup is not available in this dashboard yet/;
const ADD_SOURCE_LINK = /href="\/sources\/add"[\s\S]{0,120}>\s*Add source\s*<\/Link>/;
const CONNECT_APPS_LINK = /href="\/connect"[\s\S]{0,120}>\s*Connect apps\s*<\/Link>/;
const FORBIDDEN_MONOREPO_COPY = /PDPP monorepo checkout|generated monorepo commands|Manual browser setup/;

test("page classifies a browser-bound deep-link via the shared modality classifier (no scattered key checks)", async () => {
  const src = await read(PAGE_PATH);
  // Browser-bound detection must still come from the shared setup classifier, but
  // the normal enrollment form only admits packaged local collectors.
  assert.match(src, USES_CLASSIFIER, "page must use the shared isBrowserBoundConnector classifier");
  assert.match(src, IMPORTS_FROM_MODALITY, "browser-bound symbols must come from the shared source of truth");
  assert.doesNotMatch(
    src,
    DOES_NOT_USE_SUPPORTED_BROWSER_CLASSIFIER,
    "page must not treat proof-run browser collectors as owner-packaged enrollment paths"
  );
});

test("browser-bound deep-links stay out of the packaged local collector form", async () => {
  const src = await read(PAGE_PATH);
  assert.match(
    src,
    DEFAULT_ONLY_LOCAL_COLLECTOR,
    "default connector id must be limited to packaged local collector connectors"
  );
});

test("browser-bound deep-link renders packaged-path-pending guidance, not monorepo commands", async () => {
  const src = await read(PAGE_PATH);
  assert.match(src, RENDERS_NOTICE, "page must render packaged-path-pending browser guidance");
  assert.match(src, PENDING_BROWSER_TITLE, "the notice must name the dashboard-browser setup boundary");
  assert.match(src, PACKAGED_PENDING_COPY, "the notice must say browser setup is not available yet");
  assert.match(src, ADD_SOURCE_LINK, "the notice must link to the Sources add page");
  assert.doesNotMatch(src, CONNECT_APPS_LINK, "browser setup must not send owners to Connect apps");
  assert.doesNotMatch(src, FORBIDDEN_MONOREPO_COPY, "normal dashboard copy must not send owners to monorepo commands");
});

test("unsupported browser-bound deep-link still renders an honest notice", async () => {
  const src = await read(PAGE_PATH);
  assert.match(
    src,
    RENDERS_NOTICE,
    "page must render the browser-bound notice when a browser-bound connector is requested"
  );
});

// ─── Top-level route: no breadcrumb on a deep-link ───────────────────────
//
// /device-exporters is a top-level nav route, so the page shows no breadcrumb:
// the sidebar already shows where it is. A validated `?connector=` deep-link
// from the Sources "Add source" catalog preselects the connector in the form
// and adds no trail.

const PAGE_HEADER_TAKES_BREADCRUMB = /breadcrumbs=/;
const DEEP_LINK_TRAIL = /addConnectionBreadcrumbs/;

test("a validated add-connection deep-link adds no breadcrumb (top-level route)", async () => {
  const src = await read(PAGE_PATH);
  assert.doesNotMatch(
    src,
    PAGE_HEADER_TAKES_BREADCRUMB,
    "the top-level device exporters page must not pass a breadcrumb"
  );
  assert.doesNotMatch(src, DEEP_LINK_TRAIL, "the hard-coded deep-link trail must stay removed");
});
