// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural assertions for the record detail page's handling of a 404/410 from
 * the resource server.
 *
 * Why a file-grep style test, not a render test: the page is a React Server
 * Component that imports `next/navigation` and other Next runtime modules, so it
 * cannot be imported into a plain node test. We pin the source to the exact
 * branches a future refactor must preserve, mirroring the sibling
 * `../page-stream-unavailable.test.ts` for the stream list page.
 *
 * The contract the detail page is required to honor:
 *
 *   - It MUST branch on the typed `ResourceServerHttpError.status`, not on a
 *     substring of the error message. The previous implementation tested the
 *     wrapped message with `/\(404\)/`, which (a) silently misses a `410 Gone`
 *     and (b) couples the route to the exact string `authedFetch` happens to
 *     build. Both the list page and this page now branch on the typed status.
 *
 *   - It MUST treat BOTH `404` and `410` as not-found. A stream retired from the
 *     manifest makes `getRecord` unresolvable; the reference returns the same
 *     "Record not found" body whether the record or its whole stream is gone, so
 *     a record route maps both to Next's `notFound()`.
 *
 *   - The `ReferenceServerUnreachableError` branch (transport failure) MUST be
 *     preserved as the distinct "RS unreachable" outcome.
 *
 *   - Unknown errors (anything else) MUST still throw so the records segment
 *     error boundary at `apps/console/src/app/(console)/sources/error.tsx` shows
 *     the generic recovery surface.
 *
 *   - The brittle `/\(404\)/` message regex MUST NOT come back.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const IMPORTS_HTTP_ERROR =
  /import\s*\{[^}]*ResourceServerHttpError[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/lib\/owner-token\.ts"/;
const PRESERVES_UNREACHABLE_BRANCH = /err\s+instanceof\s+ReferenceServerUnreachableError/;
const DETECTS_HTTP_404_410 =
  /err\s+instanceof\s+ResourceServerHttpError\s*&&\s*\(err\.status\s*===\s*404\s*\|\|\s*err\.status\s*===\s*410\)/;
const CALLS_NOT_FOUND = /notFound\(\)/;
const RETHROWS_UNKNOWN = /throw\s+err;/;
const BRITTLE_REGEX = /\/\\\(404\\\)\//;
const HUMAN_KIND_RE = /humanizeFieldLabel\(streamName\)/;
const SOURCE_LABEL_BREADCRUMB_RE = /label: sourceLabel/;
const KIND_TITLE_FALLBACK_RE = /const detailPreview = recordTitlePreview\(/;
const OMITS_REDUNDANT_KIND_CRUMB_RE = /\.\.\.\(recordCrumb \? \[\{ label: recordCrumb \}\] : \[\]\)/;
const SHARED_CONNECTION_NAME_RE = /connectionDisplayName\(\s*connection\.display_name,\s*connection\.connector_display_name,\s*connection\.connector_id\s*\)/;
const UPDATED_TIME_RE = /Updated \{updatedAt\}/;
const SOURCE_TIME_FALLBACK_RE = /const sourceUpdatedAt = semanticTs \? exploreRecordTime\(semanticTs\.value\) : "";[\s\S]*?const updatedAt = sourceUpdatedAt \|\| exploreRecordTime\(record\.emitted_at\);/;
const HIDDEN_KIND_GLYPH_RE = /<RecordIdentity[^>]*showGlyph=\{false\}/;
const SCHEMA_TYPES_TO_INSPECTOR_RE = /<RecordInspector[\s\S]*?fieldSchemaTypes=\{deriveFieldSchemaTypes\(recordMetadata\)\}/;
const HIDDEN_SOURCE_TIME_FIELD_RE = /<RecordInspector[\s\S]*?hiddenBodyFields=\{semanticTs \? \[semanticTs\.field\] : undefined\}/;

test("record detail page imports the typed ResourceServerHttpError so it can branch on status", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, IMPORTS_HTTP_ERROR);
});

test("record detail page preserves the ReferenceServerUnreachableError transport-failure branch", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PRESERVES_UNREACHABLE_BRANCH);
});

test("record detail page detects a 404 or 410 from the resource server and renders not-found", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, DETECTS_HTTP_404_410);
  assert.match(src, CALLS_NOT_FOUND);
});

test("record detail page still rethrows unknown errors so the segment error boundary catches them", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RETHROWS_UNKNOWN);
});

test("record detail page does not reintroduce the brittle message-substring 404 match", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(
    src,
    BRITTLE_REGEX,
    "Branch on the typed ResourceServerHttpError.status, not on a substring of the wrapped message"
  );
});

test("the record page humanizes the kind breadcrumb and uses the kind name when no declared title exists", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // DIRECTION.md, “One data source”: kind and record titles use human names.
  assert.match(src, HUMAN_KIND_RE);
  // Round 3 item 2: all console surfaces use the shared connection-name rule.
  assert.match(src, SHARED_CONNECTION_NAME_RE);
  assert.match(src, SOURCE_LABEL_BREADCRUMB_RE);
  // DIRECTION.md, “What must stay true” #4: keep the existing detail address and align its title with the kind row.
  assert.match(src, KIND_TITLE_FALLBACK_RE);
  assert.match(src, OMITS_REDUNDANT_KIND_CRUMB_RE);
  // Round 4 items 2 and 3: no kind glyph before the record title; one relative Updated time.
  assert.match(src, HIDDEN_KIND_GLYPH_RE);
  assert.match(src, HIDDEN_SOURCE_TIME_FIELD_RE);
  // Round 4 item 4: number grouping reads the JSON-Schema type, so the inspector needs it.
  assert.match(src, SCHEMA_TYPES_TO_INSPECTOR_RE);
  assert.match(src, SOURCE_TIME_FALLBACK_RE);
  assert.match(src, UPDATED_TIME_RE);
});
