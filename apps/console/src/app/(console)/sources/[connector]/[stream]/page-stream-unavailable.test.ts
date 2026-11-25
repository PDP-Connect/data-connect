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
import { buildRecordPreview, classifyRecordKind, type RecordPreview } from "@pdpp/display";
import { exploreRecordRow } from "../../../explore/explore-presentation.ts";
import type { CanonicalReadWarning } from "../../../lib/read-envelope.ts";
import { partialReadSentence, sourceDisplayName } from "./record-list-presentation.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const COLUMNS_MENU_FILE = `${HERE}columns-menu.tsx`;

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
const KIND_MAIN_COPY_RE = /<PageHeader\n {8}actions=[\s\S]*?(?=<details)/;
const BANNED_VISIBLE_KIND_WORDS_RE = /\b(?:stream|run|connector|manifest|cursor|grant|trace|projection)\b|Raw JSON|Source-scoped Syncs/i;
const BULLET_RE = /•/;
const PARTIAL_WARNING_USE_RE = /partialReadSentence\(page\.warnings\)/;
const WARNING_DETAILS_RE = /<WarningsBanner warnings=\{page\.warnings\} \/>/;
const PARTIAL_WARNING_BEFORE_EMPTY_STATE_RE = /partialReadMessage[\s\S]*?page\.data\.length === 0/;
const EXPLORE_STYLE_RECORD_LINK_RE = /<Link[\s\S]*?className="rr-x-row[^"]*"[\s\S]*?href=\{recordHref\(r\.id\)\}/;
const EXPLORE_PRESENTATION_USE_RE = /const row = exploreRecordRow\(\{[\s\S]*?preview: preview \?\? undefined,/;
const RECORD_TITLE_LINK_RE = /<Link\n\s+aria-label=\{`Open \$\{row\.title\}[\s\S]*?<\/Link>/;
const IDENTITY_IN_RECORD_LINK_RE = /RecordIdentity/;
const EXPLORE_ROW_TITLE_RE = /<span className="rr-x-row__title text-\[15px\]">\{row\.title\}<\/span>/;
const EXPLORE_ROW_SOURCE_RE = /<span className="rr-x-row__meta truncate text-\[13px\] text-muted-foreground">\s*\{row\.source\}\s*<\/span>/;
const EXPLORE_ROW_TIME_RE = /<span className="rr-x-row__time text-\[13px\]">\{row\.time\}<\/span>/;

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

test("the kind page shows its title, display name and time once in the row", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, EXPLORE_ROW_TITLE_RE);
  assert.match(src, EXPLORE_ROW_SOURCE_RE);
  assert.match(src, EXPLORE_ROW_TIME_RE);
  assert.doesNotMatch(src, /\{row\.kind\} · \{row\.source\}/);
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

test("a kind row is titled by Explore's rule, so a record without a declared title shows its name", () => {
  // Spotify declares no title role; the page builds the preview exactly as Explore does.
  const data = { followers: 98_000_000, id: "spotify:artist:0L8ExT028jH3ddEcZwqJJ5", name: "Taylor Swift", popularity: 100 };
  const { kind } = classifyRecordKind("top_artists", data, {}, undefined, {});
  const row = exploreRecordRow(
    {
      connectionDisplayName: "Spotify",
      displayAt: "2026-11-25T18:00:00.000Z",
      preview: buildRecordPreview(kind, data, {}, {}) ?? undefined,
      stream: "top_artists",
    },
    Date.UTC(2026, 10, 25, 19)
  );

  // Data-repair brief, P1: the same calm row Explore shows (Explore titles this record "Taylor Swift").
  assert.equal(row.title, "Taylor Swift");
  // DIRECTION.md, "The look is for" 5: the row keeps its human kind, source and relative time.
  assert.equal(row.kind, "Top artists");
  assert.equal(row.source, "Spotify");
  assert.equal(row.time, "1 hour ago");
});

test("an empty title part falls through to the record's text, with no stray bullet", () => {
  const preview: RecordPreview = { body: "Taylor Swift", kind: "generic", title: " " };
  const row = exploreRecordRow({ connectionDisplayName: "Spotify", displayAt: "", preview, stream: "top_artists" });

  // Data-repair brief, P2: an empty title part must not leave a stray bullet or hide the text.
  assert.equal(row.title, "Taylor Swift");
  assert.doesNotMatch(row.title, BULLET_RE);
});

test("only a partial-results warning shows the plain sentence above the list", () => {
  const partialWarning: CanonicalReadWarning = { code: "partial_results", message: "one source unavailable" };
  const otherWarning: CanonicalReadWarning = { code: "deprecated_alias_used" };

  // DIRECTION.md, “One data source”: use a plain sentence for the state above the page sections.
  assert.equal(partialReadSentence([partialWarning]), "Some records could not be read.");
  // DIRECTION.md, “The server's own sentence ... appears ... inside Details”: unrelated warnings stay folded.
  assert.equal(partialReadSentence([otherWarning]), null);
  // DIRECTION.md, “Few words”: an empty warning list adds no sentence.
  assert.equal(partialReadSentence([]), null);
});

test("the page keeps warning details folded and renders Explore-style links as the list", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  // Data-repair brief, P2: keep warning detail folded while showing one sentence above the list.
  assert.match(src, PARTIAL_WARNING_USE_RE);
  // Data-repair brief, P2: show the sentence even when the records list is empty.
  assert.match(src, PARTIAL_WARNING_BEFORE_EMPTY_STATE_RE);
  // Data-repair brief, P2: detailed warning codes stay inside Details.
  assert.match(src, WARNING_DETAILS_RE);
  // DIRECTION.md, “The look is for” 5: render the list with the same title, context and time anatomy as Explore.
  assert.match(src, EXPLORE_STYLE_RECORD_LINK_RE);
  // Data-repair brief, P1: use Explore's record title and row presentation helpers.
  assert.match(src, EXPLORE_PRESENTATION_USE_RE);
  // Data-repair brief, P1: do not put the record identity glyph in the visible title row.
  assert.doesNotMatch(src.match(RECORD_TITLE_LINK_RE)?.[0] ?? "", IDENTITY_IN_RECORD_LINK_RE);
  // Round 2 sources brief P2: each row opens the record page, where its ID stays in the folded inspector.
  assert.match(src, /href=\{recordHref\(r\.id\)\}/);
  assert.doesNotMatch(src, /RecordIdentity|recordKey=\{r\.id\}/);
  // DIRECTION.md, “Values”: row title 15px weight 500, second line and time 13px, second text colour.
  // DIRECTION.md, “The look is for” 5: the title comes from the row presentation.
  assert.match(src, EXPLORE_ROW_TITLE_RE);
  // Round 2 sources brief P2: source display name is shown, without repeating the kind.
  assert.match(src, EXPLORE_ROW_SOURCE_RE);
  assert.doesNotMatch(src, /\{row\.kind\} · \{row\.source\}/);
  // DIRECTION.md, “The look is for” 5: the row carries its relative time.
  assert.match(src, EXPLORE_ROW_TIME_RE);
});

test("the kind page keeps Columns at list level and relationships on the record page", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.equal(src.match(/<ColumnsMenu/g)?.length, 1);
  const controls = src.slice(src.indexOf('<div className="mb-5'), src.indexOf('<details className="mb-6'));
  assert.match(controls, /<ColumnsMenu/);
  assert.doesNotMatch(src, /<details className="px-3 pb-2">/);
  assert.doesNotMatch(src, /parentLinkForCell|ReverseChildLinks/);
});

test("the kind page defaults to summary rows and only shows the record table in table view", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const tableMode = src.match(/\{tableView \? \([\s\S]*?<table className="min-w-full">[\s\S]*?\n\s+\) : null\}/)?.[0];

  assert.match(src, /const tableView = viewParam === "table"/);
  assert.match(src, />\s*Show as table\s*<\/Link>/);
  assert.ok(tableMode, "the selected-field table should be behind table view");
  assert.match(tableMode, /<table className="min-w-full">/);
  assert.match(tableMode, /Record id/);
  assert.match(src, /\{tableView && allColumns\.length > 0 && \([\s\S]*?<ColumnsMenu/);
  assert.match(src, /computeDefaultColumns\(page\.data, streamManifest\)\.filter\(\(column\) => column !== "id"\)/);
  assert.match(src, /<Link[\s\S]*?aria-label=\{`Open \$\{row\.title\}/);
});

test("the column picker names the id field Record id", async () => {
  const src = await readFile(COLUMNS_MENU_FILE, "utf8");
  assert.match(src, /column === "id" \? "Record id" : humanizeFieldLabel\(column\)/);
  assert.match(src, /href="\?columns=\*&view=table"/);
});

test("the kind page uses the shared connection-name rule, never the lowercase key", async () => {
  // Round 3 brief item 2: the header, breadcrumb and rows use the manifest name when the saved label is the connector key.
  assert.equal(sourceDisplayName({ connector_display_name: "Spotify", connector_id: "spotify", display_name: "spotify" }), "Spotify");
  assert.equal(sourceDisplayName({ connector_id: "spotify", display_name: "Family Spotify" }), "Family Spotify");
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /sourceLabel = sourceDisplayName\(connection\);/);
  assert.doesNotMatch(src, /sourceLabelForConnection/);
});
