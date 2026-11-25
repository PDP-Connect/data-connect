// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural assertions for the stream-records page's graceful handling of
 * a 404/410 from the resource server.
 *
 * Why a file-grep style test, not a render test: the page is a React Server
 * Component that imports `next/navigation` and other Next runtime modules,
 * so it cannot be imported into a plain node test. We instead pin the source
 * to the exact branches a future refactor must preserve, mirroring the
 * pattern in `apps/console/src/app/(console)/sources/actions.test.ts`.
 *
 * The contract the page is required to honor:
 *
 *   - It MUST import the typed `ResourceServerHttpError` from owner-token so
 *     it can branch on status, instead of letting a generic `Error` thrown by
 *     `authedFetch` flow to the segment error boundary.
 *
 *   - When `queryRecords` throws `ResourceServerHttpError` with status 404
 *     (or 410 Gone), the page MUST render a bounded "this stream is not
 *     available" state inside the dashboard shell - not crash to `error.tsx`.
 *     Owner-mode stream visibility is manifest-derived; once a stream is
 *     dropped from the manifest the records-read endpoint legitimately
 *     returns 404, and that is an expected end-state, not a runtime error.
 *
 *   - The `ReferenceServerUnreachableError` branch (transport failure) MUST
 *     be preserved as the existing distinct outcome: that is "the RS is
 *     unreachable", not "this stream is gone".
 *
 *   - Unknown errors (anything else) MUST still throw so the segment error
 *     boundary at `apps/console/src/app/(console)/sources/error.tsx` shows
 *     the generic "Couldn't load your connections" recovery surface.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const IMPORTS_HTTP_ERROR =
  /import\s*\{[^}]*ResourceServerHttpError[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/lib\/owner-token\.ts"/;
const PRESERVES_UNREACHABLE_BRANCH = /err\s+instanceof\s+ReferenceServerUnreachableError/;
const DETECTS_HTTP_404 =
  /err\s+instanceof\s+ResourceServerHttpError\s*&&\s*\(err\.status\s*===\s*404\s*\|\|\s*err\.status\s*===\s*410\)/;
const BOUNDED_STATE_COPY = /not\s+available/i;
const RETHROWS_UNKNOWN = /throw\s+err;/;
const RS_CLIENT_THROWS_TYPED_HTTP_ERROR = /throw\s+new\s+ResourceServerHttpError\(path,\s*res\.status,\s*body\)/;
const HUMAN_KIND_RE = /humanizeFieldLabel\(streamName\)/;
const HUMAN_PAGE_TITLE_RE = /title=\{humanizeFieldLabel\(streamName\)\}/;
const SOURCE_LABEL_BREADCRUMB_RE = /label: sourceLabel/;
const DETAILS_WRAP_EVIDENCE_RE = /<details[\s\S]*?<StreamEvidenceSection[\s\S]*?<\/details>/;
const REMOVED_DUPLICATE_SOURCE_LINK_RE = /value="Open source"/;
const SECONDARY_TIMESTAMP_FORMATTED_RE = /<IcTimestamp value=\{cardTs\.secondary\.value\} \/>/;
const SECONDARY_TIMESTAMP_RAW_RE = /<dd[^>]*>\s*\{cardTs\.secondary\.value\}\s*<\/dd>/;
const CARD_DATE_FIELD_FORMATTED_RE = /const dateValue = isDateValue\(raw\)[\s\S]*?<IcTimestamp value=\{dateValue\} \/>/;
const TABLE_DATE_FIELD_FORMATTED_RE = /const rawValue = r\.data\?\.\[c\][\s\S]*?<IcTimestamp value=\{dateValue\} \/>/;
const KIND_MAIN_COPY_RE = /<PageHeader\n {8}actions=[\s\S]*?(?=<details)/;
const BANNED_VISIBLE_KIND_WORDS_RE = /\b(?:stream|run|connector|manifest|cursor|grant|trace|projection)\b|Raw JSON|Source-scoped Syncs/i;

test("stream page imports the typed ResourceServerHttpError so it can branch on status", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, IMPORTS_HTTP_ERROR);
});

test("stream page preserves the ReferenceServerUnreachableError transport-failure branch", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PRESERVES_UNREACHABLE_BRANCH);
});

test("stream page detects a 404 or 410 from the resource server and renders a bounded state", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, DETECTS_HTTP_404);
  assert.match(src, BOUNDED_STATE_COPY);
});

test("stream page still rethrows unknown errors so the segment error boundary catches them", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RETHROWS_UNKNOWN);
});

test("the kind page uses a human name in its title and breadcrumb and keeps technical facts folded", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // DIRECTION.md, "What must stay true": no raw names; technical facts stay in Details.
  assert.match(src, HUMAN_KIND_RE);
  assert.match(src, HUMAN_PAGE_TITLE_RE);
  // data-pages.md, decision 1: show the data source label instead of its ID.
  assert.match(src, SOURCE_LABEL_BREADCRUMB_RE);
  assert.match(src, DETAILS_WRAP_EVIDENCE_RE);
  assert.doesNotMatch(src, REMOVED_DUPLICATE_SOURCE_LINK_RE);
});

test("the kind page formats the secondary card timestamp instead of showing raw ISO text", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // DIRECTION.md, "What must stay true": no raw dates on these pages.
  assert.match(src, SECONDARY_TIMESTAMP_FORMATTED_RE);
  assert.doesNotMatch(src, SECONDARY_TIMESTAMP_RAW_RE);
  assert.match(src, CARD_DATE_FIELD_FORMATTED_RE);
  assert.match(src, TABLE_DATE_FIELD_FORMATTED_RE);
});

test("the kind page keeps technical words out of the visible header and controls", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const mainCopy = src.match(KIND_MAIN_COPY_RE)?.[0];

  // DIRECTION.md, "What must stay true": banned terms stay folded under Details.
  assert.ok(mainCopy, "the page header and controls should precede the folded details");
  assert.doesNotMatch(mainCopy, BANNED_VISIBLE_KIND_WORDS_RE);
});

test("rs-client.authedFetch throws the typed ResourceServerHttpError on non-OK responses", async () => {
  const rsClientPath = `${HERE}../../../lib/rs-client.ts`;
  const src = await readFile(rsClientPath, "utf8");
  // The typed error carries (path, status, body) so callers can branch on
  // status without re-parsing a string message.
  assert.match(
    src,
    RS_CLIENT_THROWS_TYPED_HTTP_ERROR,
    "authedFetch must throw ResourceServerHttpError on non-OK so callers can branch on status"
  );
});
