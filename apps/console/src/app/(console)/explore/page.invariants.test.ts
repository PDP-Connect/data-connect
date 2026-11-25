// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// explore-data-assembler.ts moved to the shared @pdpp/operator-ui package;
// resolve it from the repo root. page.tsx + next.config.mjs stay console-local.
const REPO_ROOT = new URL("../../../../../../", import.meta.url);
const ASSEMBLER_FILE = fileURLToPath(
  new URL("reference-implementation/vendor/operator-ui/src/explore/explore-data-assembler.ts", REPO_ROOT)
);
const COMPONENTS_CSS_FILE = fileURLToPath(
  new URL("reference-implementation/vendor/brand-react/src/components.css", REPO_ROOT)
);
const EXPLORE_CSS_FILE = `${HERE}explore-page.css`;
const RECORD_INSPECTOR_FILE = fileURLToPath(
  new URL("apps/console/src/app/(console)/components/record-inspector.tsx", REPO_ROOT)
);
const LIVE_PAGE_FILE = `${HERE}page.tsx`;
const EXPLORE_CANVAS_FILE = `${HERE}explore-canvas.tsx`;
const RECORDS_EXPLORER_VIEW_FILE = fileURLToPath(
  new URL("reference-implementation/vendor/operator-ui/src/components/views/records-explorer-view.tsx", REPO_ROOT)
);

const LOAD_TIMELINE_RE = /\bloadTimeline\b/;
const CONNECTOR_INSTANCE_ID_RE =
  /connectorInstanceId:\s*summary\.connector_instance_id\s*\?\?\s*summary\.connection_id/;
const CONNECTION_ID_RE = /connectionId:\s*summary\.connection_id/;
const CONNECTION_DISPLAY_RE = /connectionDisplayName:\s*connectorSummaryDisplayName\(summary\)/;
const CONNECTION_DISPLAY_HELPER_RE = /function connectorSummaryDisplayName\(summary: RefConnectorIdentitySummary\)/;

const ASSEMBLER_IMPORT_RE = /from\s+["'][^"']*explore-data-assembler(?:\.ts)?["']/;
const INLINE_FEED_LOADER_RE =
  /\bfunction\s+loadEmptyQueryFeed\b|\bfunction\s+loadTimeRangeFeed\b|\bfunction\s+loadSearchFeed\b/;
const OWNER_FACING_DEMO_COPY_RE =
  /jump to an id|same call any client makes|window capped|names overlap across connections/i;
const ACTIVE_RANGE_HELPER_RE = /activeRangeKey\(\{\s*since:\s*data\.since,\s*until:\s*data\.until\s*\}\)/;
const STREAM_RECORDS_HREF_HELPER_RE = /function buildStreamRecordsHref\(\s*recordsBasePath: string,/;
const LIVE_PAGE_ROUTE_MAP_RECORDS_BASE_RE = /recordsBasePath=\{dashboardRoutes\.section\.records\}/g;
const CANVAS_RECORDS_BASE_PROP_RE = /recordsBasePath: string;/;
const CANVAS_DERIVED_RECORDS_BASE_RE = /explorePath\.replace\([^)]*\)[^;\n]*\/records/;
// The record-detail href is built by the pure buildRecordDetailHref helper in
// ./explore-control-state.ts (unit-tested there) from clean path segments — NOT
// by appending the record key to the stream href (which carries `?order=desc`;
// appending after a query string swallows the key into the order value and lands
// taps on the whole-stream list instead of the record). The canvas must IMPORT it.
const RECORD_DETAIL_IMPORTS_HELPER_RE =
  /import \{[\s\S]*buildRecordDetailHref[\s\S]*\} from "\.\/explore-control-state\.ts";/;
// Regression guard: the canvas must NOT re-introduce the old streamHref-append shape.
const RECORD_DETAIL_NO_STREAM_HREF_APPEND_RE =
  /const streamHref = buildStreamRecordsHref\(recordsBasePath, entry\);\s*return \[streamHref, encodeURIComponent\(entry\.recordId\)\]\.join\("\/"\);/;
const INSPECTOR_STREAM_HREF_RE =
  /streamRecordsHref=\{data\.peek \? buildStreamRecordsHref\(recordsBasePath, data\.peek\) : null\}/;
const INSPECTOR_STREAM_LINK_RE =
  /<a className="rr-x-stream-all" href=\{streamRecordsHref\}>Browse this kind →<\/a>/;
const CANVAS_PASSES_RECORDS_BASE_RE =
  /<RecordInspector[\s\S]*record=\{data\.peek\}[\s\S]*relationships=\{peekRelationships\}/;
const HEADER_FULL_STREAM_USES_HELPER_RE =
  /const fullListHref =[\s\S]*buildCompleteStreamHref\(\s*recordsBasePath,[\s\S]*connectionId: scopedConnection\.connectionId,[\s\S]*connectorId: scopedConnection\.connectorId,[\s\S]*stream: selectedStreams\[0\] \?\? ""[\s\S]*fullListHref=\{fullListHref\}/;
const BURST_STREAM_LABEL_RE = /const kindLabel = rep\?\.stream \? humanizeFieldLabel\(rep\.stream\) : "Records";[\s\S]*<div className="rr-x-burst__head">\{kindLabel\} · \{sourceName\}<\/div>/;
// R2: feed rows MUST render a per-record time-of-day in the LIVE FeedRow (the
// console renders explore-canvas.tsx FeedRow, not the operator-ui card). Pin the
// semantic contract: the row carries the time wrapper, labels non-semantic rows
// as "ingested", and still renders a `precision="time"` Timestamp. Keep the
// assertions loose enough to tolerate JSX reshaping.
const ROW_TIME_TEXT_RE = /<span className="rr-x-row__time">\{time\}<\/span>/;
const ROW_TIME_CSS_RE = /\.explore-page \.rr-x-row__time\s*\{[\s\S]*?font-family:\s*var\(--font-sans\)/;
// Future-dated records (e.g. YNAB future budget months) must NOT sit above today:
// the recent timeline partitions them into a collapsed "Upcoming" section. Pin the
// partition call, the section render, and its CSS so it can't regress to interleaving.
// The SERVER owns the past/future split (clamps the main feed to a pinned now +
// returns a separate Upcoming projection). The canvas MUST render the server's
// data.upcoming / data.upcomingTotal and MUST NOT re-derive the boundary client-side
// (no partitionFeedByTime over the feed — a recompute boundary would skip records).
// The Upcoming body renders the SERVER's data.upcoming, day-grouped but WITHOUT an
// inner burst collapse (the section is already a disclosure — a second "expand"
// inside it is the double-collapse clunk). Still proves data.upcoming is consumed.
const UPCOMING_USES_SERVER_RE = /groupFeedDaysNoBursts\(\[\.\.\.data\.upcoming\]\)/;
const UPCOMING_TOTAL_FROM_SERVER_RE = /const upcomingCount = data\.upcomingTotal/;
const UPCOMING_NO_CLIENT_PARTITION_RE = /partitionFeedByTime/;
const UPCOMING_SECTION_RENDER_RE = /upcomingCount > 0 \?[\s\S]*<UpcomingSection/;
const UPCOMING_CSS_RE = /\.rr-x-upcoming__toggle\s*\{/;
const DESKTOP_ROW_PEEK_ONCLICK_RE = /className=\{`\$\{rowClassName\} rr-x-row--desktop`\}[\s\S]{0,240}onClick=\{onSelect\}/;
// Slice 3: selection is machine-readable + visible. The desktop row is a toggle
// BUTTON, so aria-pressed is the correct ARIA selected-state (aria-selected is not
// valid on a button role); data-selected carries the machine-readable selected
// flag (design.md §6 allows aria-selected OR data-selected). Visible via a selected
// fill + a keyboard focus-visible ring.
const DESKTOP_ROW_ARIA_PRESSED_RE = /aria-pressed=\{selected\}/;
const ROW_SELECTED_CSS_RE = /\.rr-x-row\.is-selected\s*\{/;
const ROW_FOCUS_VISIBLE_CSS_RE = /\.rr-x-row:focus-visible\s*\{/;
// Slice 3 keyboard contract on the focused desktop row: the handler routes
// through the PURE resolveRowKeyAction decision (Enter peeks, Cmd/Ctrl-Enter opens
// the full route, Escape clears, arrows move). The behavior is unit-tested in
// explore-control-state.test.ts; here we pin that the row wires all four actions.
const ROW_KEYBOARD_USES_RESOLVER_RE = /const \{ action, preventDefault \} = resolveRowKeyAction\(event\);/;
const ROW_KEYBOARD_ARROW_DOWN_RE = /onArrow\(1\)/;
const ROW_KEYBOARD_ARROW_UP_RE = /onArrow\(-1\)/;
const ROW_KEYBOARD_PEEK_RE = /action === "peek"[\s\S]{0,40}onSelect\(\)/;
const ROW_KEYBOARD_OPEN_FULL_RE = /action === "open-full"[\s\S]{0,40}onOpenFull\(\)/;
const ROW_KEYBOARD_CLEAR_RE = /action === "clear"[\s\S]{0,40}onClearSelection\(\)/;
// Slice 3 (#3): the redundant feed-level "inspect read request" disclosure is
// REMOVED; "copy view link" is the single share affordance and must remain.
const INSPECT_READ_REQUEST_RE = /inspect read request/;
const COPY_VIEW_LINK_RE = /copy view link/;
// Slice 3: multi-select is explicitly NOT added — no checkbox column, no bulk
// selection state. These patterns must be ABSENT from the canvas.
const MULTI_SELECT_CHECKBOX_RE = /type="checkbox"/;
const MULTI_SELECT_STATE_RE = /selectedRecordIds|bulkSelect|selectedRows\b/;
const DESKTOP_ROW_DATA_SELECTED_RE = /data-selected=\{selected \? "true" : undefined\}/;
const MOBILE_ROW_LABEL_OWNS_ACTION_RE = /aria-label=\{`Open \$\{title\} · \$\{kind\} · \$\{sourceName\}`\}/;
// The search-mode header must have an explicit layout, or the descriptor-claim
// title and the escape ramp render inline and run together ("…'query'Browse…").
const SEARCH_HEADER_CSS_RE = /\.rr-x-search-header\s*\{[\s\S]*?display:\s*flex/;
// Slice 2: the record-id jump is now an INLINE affordance in the ONE unified
// input (feedback #4), not a second labeled box. The acceptance is that a pasted
// exact id is DETECTED and surfaced as a "Jump to record" affordance.
const GO_TO_RECORD_LABEL_RE = /Jump to record[\s\S]*detectRecordIdJump/;
const GO_TO_RECORD_SCOPED_RE =
  /if \(props\.scopedConnection && props\.selectedStream\) \{[\s\S]*buildRecordDetailHref\(props\.recordsBasePath/;
const GO_TO_RECORD_UNSCOPED_RE =
  /function QueryInput[\s\S]*onSearchRecordId\(jumpId\);[\s\S]*const searchRecordId = useCallback[\s\S]*setDraft\(recordId\);[\s\S]*navigate\(\{ query: recordId, peek: undefined \}\)/;
const GO_TO_RECORD_FEEDBACK_RE =
  /recordIdJumpFeedback[\s\S]*No exact record ID matched in this view[\s\S]*No exact ID match in this page/;
const FULL_STREAM_WHOLE_STREAM_NOTE_RE =
  /The full list opens the whole kind; text search, date range, and local filters stay in Explore/;
const HEADER_FULL_LIST_DETAILS_RE =
  /<details className="rr-x-technical-details rr-x-explore-details">[\s\S]*fullListHref[\s\S]*<Link className="rr-link" href=\{fullListHref\}>Open the full list →/;
const SEARCH_HAS_MORE_RE =
  /hasMoreRecords = page\.has_more === true[\s\S]*search_page_limited[\s\S]*truncated: hasMoreRecords/;
// Slice 2: facet rows are now built by the shared FacetRow (an INCLUDE toggle +
// an "is not" EXCLUDE toggle). The selected/excluded state is machine-readable
// via aria-pressed on BOTH the include button (`on`) and the exclude button
// (`excluded`). ConnectionFacets and StreamFacets both render through FacetRow.
const FACET_ARIA_PRESSED_RE = /function FacetRow[\s\S]*aria-pressed=\{on\}[\s\S]*aria-pressed=\{excluded\}/;
// Sort exposes selected state via aria-pressed; the DATE control is now the single
// Date chip (one canonical representation — no more four range buttons), whose presets
// are a radio-group exposing selection via aria-checked against the active range. Each
// piece is asserted independently (order-agnostic) since the DateChip component is
// declared above FeedControls in the source.
const SORT_NEWEST_ARIA_RE = /aria-pressed=\{order === "newest"\}/;
const SORT_OLDEST_ARIA_RE = /aria-pressed=\{order === "oldest"\}/;
const DATE_PRESET_ARIA_CHECKED_RE = /aria-checked=\{selected\}/;
const RAW_JSON_DISCLOSURE_RE =
  /<details className="rr-x-raw rr-x-inspector-details">[\s\S]*<summary>Details<\/summary>[\s\S]*<summary>Raw JSON<\/summary>[\s\S]*<pre>\{record\.bodyJson\}<\/pre>/;
const INSPECTOR_OPEN_FULL_RECORD_RE = /recordHref \? <a href=\{recordHref\}>Open full record<\/a>/;
const CANVAS_RECORD_HREF_RE = /recordHref=\{data\.peek \? buildRecordDetailHref\(recordsBasePath, data\.peek\) : null\}/;
const CANVAS_COUNT_LINE_RE = /<FeedStatusLine exactCountIsCurrent=\{exactCountIsCurrent\} exactTotal=\{exactTotal\} visibleCount=\{visibleFeed\.length\} \/>/;
const CANVAS_NO_OLD_VIEWS_COUNT_RE = /<div className="rr-x-views"|<span className="rr-x-views__name">/;
const CANVAS_COUNT_HELPER_CALL_RE =
  /exploreCountLine\(\{ exactTotal: exactCountIsCurrent \? exactTotal : null, pageCount: visibleCount \}\)/;

// ─── Slice 4: manifest-authored presentation — honest generic fallback ───────
// The generic kind must render the HONEST key/value card, not `() => null` (the
// old bare-summary fallback). Pin that PREVIEW_BODY_BY_KIND.generic maps to
// GenericBody and that GenericBody renders the humanized key/value table.
const GENERIC_BODY_MAPPED_RE = /generic:\s*\(preview\)\s*=>\s*<GenericBody preview=\{preview\}\s*\/>/;
const GENERIC_BODY_RENDERS_KV_RE =
  /function GenericBody\([\s\S]*preview\.fields\.map\(\(field\)[\s\S]*?<dt className="rr-x-kv__label">\{field\.label\}<\/dt>[\s\S]*?<dd className="rr-x-kv__value">\{field\.value\}<\/dd>/;
// The humanized label is a LABEL transform via the shared humanizeFieldLabel —
// the inspector peek table must use it, never infer semantics from the name.
const HUMANIZE_IMPORT_RE = /import \{[^}]*\bhumanizeFieldLabel\b[^}]*\} from "@pdpp\/display";/;
const PEEK_HUMANIZED_LABEL_RE = /humanizeFieldLabel\(field\.name\)/;
// The honest generic key/value card has design-system CSS (no inline guess card).
const GENERIC_KV_CSS_RE = /\.rr-x-kv\s*\{/;
// The assembler reads declared ROLES from field_capabilities[].role (the LIVE
// x_pdpp_role vocabulary, review-approved 2026-06-21) into buildRecordPreview, so a
// declared title/body/amount renders a typed card with no field-name guess. The
// role is parsed via parseFieldRole (unknown roles drop → generic fallback).
const ASSEMBLER_ROLES_SEAM_RE =
  /function declaredRolesFromCapabilities\([\s\S]*\):\s*DeclaredFieldRoles\s*\{[\s\S]*parseFieldRole\(cap\.role\)/;
const ASSEMBLER_PASSES_ROLES_RE = /buildRecordPreview\(kind, data, dtypes, droles\)/;
// The live feed uses one shared presentation rule for its title and context.
const CANVAS_RECORD_ROW_HELPER_RE = /const \{ title, source: sourceName, kind, time \} = exploreRecordRow\(entry\);/;
const CANVAS_ROW_CONTEXT_RE = /<span className="rr-x-row__meta">\{kind\} · \{sourceName\}<\/span>/;
const CANVAS_ROW_TITLE_TEXT_RE = /<span className="rr-x-row__title">\{title\}<\/span>/;
const CANVAS_ROW_NO_LEGACY_SUMMARY_RE = /entry\.summary|matchExcerpt/;
const CANVAS_NO_MATCH_EXCERPT_RE = /matchExcerpt|rr-x-mark/;
const CANVAS_NO_EXTRA_ROW_CONTROLS_RE = /className="rr-x-row__action"|className="rr-x-row-open"|className="rr-x-row__snippet/;

// ─── honesty-copy cell: no engine-vocabulary badge leaks (THE-LENS Part 0 / Gate 1) ──
//
// The per-row engine-mode badge (lexical/semantic/hybrid) read as dev-console output and
// carried zero owner-actionable meaning. Its RENDER must be absent on both surfaces — but
// the `entry.retrievalMode` DATA FIELD stays (it gates the match excerpt + search order).
// We grep for the specific render expressions, NOT the word "retrieval" (which survives in
// retained comments/identifiers), so the data-field use cannot trip these guards.
const CANVAS_ROW_REL_BADGE_RENDER_RE = /<span className="rr-x-row__rel">\{entry\.retrievalMode\}<\/span>/;
const LEGACY_RETRIEVAL_BADGE_COMPONENT_RE = /function RetrievalBadge\(/;
const LEGACY_RETRIEVAL_BADGE_RENDER_RE = /<RetrievalBadge\b/;
// The L4 search-fallback warning must carry the honest code/message and no engine word.
const ASSEMBLER_HONEST_WARNING_CODE_RE = /code:\s*"search_coverage_reduced"/;
const ASSEMBLER_OLD_HYBRID_WARNING_RE = /hybrid_unavailable|Hybrid retrieval was advertised|fell back to lexical/;

// ─── Slice 5: polish — motion, mobile loading position, operators-popover clamp ──
//
// All assertions are CSS/canvas source-scans (no rendering), matching the existing
// reduced-motion precedent the loading-states work established (rr-x-progress /
// rr-x-row__pending). The review red lines for Slice 5 (verdict §12): design-system
// tokens, reduced-motion gated, NO layout shift, loading never dims readable
// records, operators popover within the viewport.

// (#2) Mobile loading position: the route-progress bar is pinned to the TOP of the
// VISIBLE viewport on phones (position: fixed; top: 0) inside the ≤860px block, so
// it is never scrolled above the fold. `fixed` is out-of-flow → no layout shift.
const MOBILE_PROGRESS_FIXED_RE =
  /@media \(max-width: 860px\) \{[\s\S]*?\.rr-x-progress \{\s*position: fixed;\s*top: 0;/;
// The desktop base rule stays `position: absolute` (top of the canvas, not the
// viewport) — the mobile rule is an override, not a global change.
const DESKTOP_PROGRESS_ABSOLUTE_RE = /\.rr-x-progress \{\s*position: absolute;\s*top: 0;/;
// (#2 / review red line) Loading must NOT dim or disable already-readable records.
// The feed region carries aria-busy ONLY (feedAriaBusy), never an opacity dim or a
// pointer-events block while pending. Pin the canvas comment + the absence of a dim.
const FEED_NO_DIM_RE = /aria-busy=\{feedAriaBusy\(isPending\)\}/;
// A dim/disable overlay would look like one of these on the feed region; none may
// be wired to the pending state. (Guards against a regression that gates opacity or
// pointer-events on isPending for the feed.)
const FEED_PENDING_DIM_RE =
  /className="rr-x-main"[\s\S]{0,120}(?:opacity|pointer-events)[\s\S]{0,40}isPending|isPending[\s\S]{0,40}(?:opacity:\s*0|pointer-events:\s*none)[\s\S]{0,40}rr-x-main/;

// (#6) Operators / typeahead popover stays within the viewport on desktop AND
// mobile: pure-CSS clamp — anchored left:0/right:0 to the input (width-bounded, no
// right overflow), capped by max-width:100vw and a viewport-relative max-height
// with internal scroll (no bottom overflow). No JS measurement.
const TYPEAHEAD_VIEWPORT_CLAMP_RE =
  /\.rr-x-typeahead \{(?=[\s\S]*?left: 0;)(?=[\s\S]*?right: 0;)(?=[\s\S]*?max-width: 100vw;)(?=[\s\S]*?max-height: min\(280px, 60vh\);)(?=[\s\S]*?overflow-y: auto;)[\s\S]*?\}/;

// Mobile: the options popover (operator-syntax legend) becomes a full-width sheet,
// same as the date popover, so it doesn't overflow when the trigger wraps near the
// left edge. The override turns off the absolute right:0 anchor and spans full width.
const OPTIONS_VIEWPORT_CLAMP_RE =
  /\.rr-x-options__body \{(?=[\s\S]*?right: 0;)(?=[\s\S]*?left: 0;)(?=[\s\S]*?width: auto;)(?=[\s\S]*?max-width: none;)[\s\S]*?\}/;

// (#7) Motion communicates model state and is reduced-motion gated with a static
// fallback. The shared reveal (Upcoming body / burst expand / day-group mount):
//  - base rule = STATIC visible fallback (opacity:1; transform:none) OUTSIDE any
//    media query, so reduced-motion users see content immediately;
//  - the keyframe animation lives ONLY inside @media (prefers-reduced-motion:
//    no-preference);
//  - the keyframe animates ONLY opacity + transform (no width/height/margin) → no
//    layout shift.
const REVEAL_STATIC_FALLBACK_RE =
  /\.rr-x-upcoming__body,\s*\.rr-x-burst__rows,\s*\.rr-x-day \{\s*\/\*[\s\S]*?\*\/\s*opacity: 1;\s*transform: none;\s*\}/;
const REVEAL_GATED_BEHIND_NO_PREFERENCE_RE =
  /@media \(prefers-reduced-motion: no-preference\) \{\s*\.rr-x-upcoming__body,\s*\.rr-x-burst__rows,\s*\.rr-x-day \{\s*animation: rr-x-reveal var\(--duration-enter\) var\(--ease-enter\) both;\s*\}\s*\}/;
const REVEAL_KEYFRAME_TRANSFORM_OPACITY_ONLY_RE =
  /@keyframes rr-x-reveal \{\s*from \{\s*opacity: 0;\s*transform: translateY\(4px\);\s*\}\s*to \{\s*opacity: 1;\s*transform: translateY\(0\);\s*\}\s*\}/;
// Selection motion: the row crossfades background + selected outline via the state
// token (paint-only → no layout shift), and the token collapses under reduced
// motion (base.css zeroes --duration-*), so no keyframe gating is required for a
// pure transition.
const SELECTION_TRANSITION_RE =
  /\.rr-x-row \{[\s\S]*?transition:\s*background var\(--duration-state\) var\(--ease-standard\),\s*box-shadow var\(--duration-state\) var\(--ease-standard\);/;
// The burst expanded rows are wrapped in the reveal container in the canvas.
const BURST_REVEAL_WRAPPER_RE = /<div className="rr-x-burst__rows">/;

test("time-range explorer keeps connection identity instead of using connector-scoped timeline rows", async () => {
  const src = await readFile(ASSEMBLER_FILE, "utf8");

  assert.doesNotMatch(src, LOAD_TIMELINE_RE);
  assert.match(src, CONNECTOR_INSTANCE_ID_RE);
  assert.match(src, CONNECTION_ID_RE);
  assert.match(src, CONNECTION_DISPLAY_RE);
  assert.match(src, CONNECTION_DISPLAY_HELPER_RE);
});

test("live explore page delegates to the shared assembler", async () => {
  const src = await readFile(LIVE_PAGE_FILE, "utf8");
  assert.match(src, ASSEMBLER_IMPORT_RE, "live page must import explore-data-assembler");
  assert.doesNotMatch(src, INLINE_FEED_LOADER_RE, "live page must not define inline feed loader functions");
});

test("Explore controls do not render demo-era owner-facing copy", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  assert.doesNotMatch(src, OWNER_FACING_DEMO_COPY_RE);
});

test("Explore range shortcuts use a single active-range helper", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  assert.match(src, ACTIVE_RANGE_HELPER_RE);
});

test("Explore selected-record inspector exposes the complete scoped stream", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  const inspector = await readFile(RECORD_INSPECTOR_FILE, "utf8");

  assert.match(src, STREAM_RECORDS_HREF_HELPER_RE, "Explore must have one complete-stream route helper");
  assert.match(
    src,
    RECORD_DETAIL_IMPORTS_HELPER_RE,
    "Explore canvas must import buildRecordDetailHref from the pure control-state helper (clean path segments, no ?order= query)"
  );
  assert.doesNotMatch(
    src,
    RECORD_DETAIL_NO_STREAM_HREF_APPEND_RE,
    "record detail href must NOT append the record key to the stream href (the ?order=desc query swallows the key, landing taps on the whole-stream list)"
  );
  assert.match(src, INSPECTOR_STREAM_HREF_RE, "selected-record inspector must compute a complete-stream href");
  assert.match(inspector, INSPECTOR_STREAM_LINK_RE, "selected-record inspector must show a complete-stream action");
  assert.match(src, CANVAS_PASSES_RECORDS_BASE_RE, "inspector must receive the records base path");
  assert.match(src, HEADER_FULL_STREAM_USES_HELPER_RE, "the scoped full-list link uses the shared complete-list helper");
  assert.match(src, HEADER_FULL_LIST_DETAILS_RE, "the selected kind's full-list link stays reachable in Details");
});

test("live Explore binds all record links to the console route map", async () => {
  const page = await readFile(LIVE_PAGE_FILE, "utf8");
  const canvas = await readFile(EXPLORE_CANVAS_FILE, "utf8");

  assert.equal(
    page.match(LIVE_PAGE_ROUTE_MAP_RECORDS_BASE_RE)?.length,
    2,
    "both live and demo Explore renders must receive the route-map-owned records base path"
  );
  assert.match(canvas, CANVAS_RECORDS_BASE_PROP_RE, "the client canvas must accept a serialized records base path");
  assert.doesNotMatch(
    canvas,
    CANVAS_DERIVED_RECORDS_BASE_RE,
    "Explore must not derive the records route by rewriting the Explore path"
  );
});

test("Slice 4: undeclared records render the honest generic key/value card, not a bare summary or guessed card", async () => {
  const view = await readFile(RECORDS_EXPLORER_VIEW_FILE, "utf8");
  const css = await readFile(COMPONENTS_CSS_FILE, "utf8");

  assert.match(
    view,
    GENERIC_BODY_MAPPED_RE,
    "the generic kind must map to GenericBody (the honest key/value card), not `() => null`"
  );
  assert.match(
    view,
    GENERIC_BODY_RENDERS_KV_RE,
    "GenericBody must render the humanized key/value table from preview.fields"
  );
  assert.match(view, HUMANIZE_IMPORT_RE, "the view must import the shared humanizeFieldLabel transform");
  assert.match(
    view,
    PEEK_HUMANIZED_LABEL_RE,
    "the inspector peek table must humanize field labels (LABEL-only, never a type/role signal)"
  );
  assert.match(css, GENERIC_KV_CSS_RE, "the honest generic key/value card must have design-system CSS");
});

test("Slice 4: the assembler reads declared ROLES from field_capabilities[].role into buildRecordPreview", async () => {
  const src = await readFile(ASSEMBLER_FILE, "utf8");

  assert.match(
    src,
    ASSEMBLER_ROLES_SEAM_RE,
    "declaredRolesFromCapabilities must parse field_capabilities[].role via parseFieldRole (x_pdpp_role is LIVE)"
  );
  assert.match(src, ASSEMBLER_PASSES_ROLES_RE, "buildRecordPreview must receive the declared-roles map");
});

test("Explore row titles use the human title rule and keep one context line", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  assert.match(src, CANVAS_RECORD_ROW_HELPER_RE, "FeedRow must use the shared human title rule");
  assert.match(src, CANVAS_ROW_TITLE_TEXT_RE, "FeedRow must show its title");
  assert.match(src, CANVAS_ROW_CONTEXT_RE, "FeedRow must show the human kind and data source once");
  assert.doesNotMatch(src, CANVAS_ROW_NO_LEGACY_SUMMARY_RE, "FeedRow must not add a heuristic title or a second excerpt");
});

test("Explore burst headers humanize stream keys without changing stream identity", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");

  assert.match(
    src,
    BURST_STREAM_LABEL_RE,
    "burst headers must render a human label instead of exposing a raw stream key"
  );
});

test("Explore rows omit retrieval labels and match excerpts", async () => {
  const canvas = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  const legacy = await readFile(RECORDS_EXPLORER_VIEW_FILE, "utf8");
  assert.doesNotMatch(canvas, CANVAS_ROW_REL_BADGE_RENDER_RE, "rows must not expose retrieval mode labels");
  assert.doesNotMatch(legacy, LEGACY_RETRIEVAL_BADGE_COMPONENT_RE, "the shared view must not restore a retrieval badge");
  assert.doesNotMatch(legacy, LEGACY_RETRIEVAL_BADGE_RENDER_RE, "the shared view must not render a retrieval badge");
  assert.doesNotMatch(canvas, CANVAS_NO_MATCH_EXCERPT_RE, "Explore rows do not render a second match excerpt");
});

test("honesty-copy: the search-fallback warning uses non-engine copy (L4)", async () => {
  const assembler = await readFile(ASSEMBLER_FILE, "utf8");
  assert.match(
    assembler,
    ASSEMBLER_HONEST_WARNING_CODE_RE,
    "the search-fallback warning must use code:'search_coverage_reduced' (human code-label)"
  );
  assert.doesNotMatch(
    assembler,
    ASSEMBLER_OLD_HYBRID_WARNING_RE,
    "the old hybrid_unavailable / 'Hybrid retrieval was advertised' / 'fell back to lexical' warning copy must be gone"
  );
});

// ─── honesty-copy cell: SIBLING WarningList messages carry no engine/impl ──────
// vocabulary and no raw-error interpolation (THE-LENS Part 0: "implementation
// nouns leaking to the owner" + "machine/AI output to a human"). These three
// warnings render through the SAME WarningList <span className="rr-x-warn__msg">
// path as the L4 fix, unconditionally (no debug flag), so the same principle
// applies. The raw error stays as debug evidence in a server-side console.warn —
// it must NOT reach the rendered `message:`.
//
// We extract the `message:` line that FOLLOWS each `code: "<code>"` line so the
// guard targets ONLY the owner-rendered string, never the sibling console.warn
// debug line (which legitimately interpolates describeError(err) / peek.error).
const WARNING_CODES_UNDER_GUARD = ["search_meta_warning", "search_cursor_unavailable", "peek_unreachable"] as const;

// Implementation/engine nouns that must never reach an owner-facing message.
const IMPL_NOUN_RE =
  /grant projection|blob affordance|stream metadata unavailable|Most-recent mode failed|Peek read failed|Most-recent mode/i;
// Raw-error / internal-path interpolation that must never reach a message.
const RAW_ERROR_INTERP_RE =
  /\$\{describeError\(|\$\{peek\.error\}|\$\{peek\.connectorId\}|\$\{peek\.stream\}|\$\{peek\.recordId\}/;
// First `message:` string literal following a `code: "..."` line.
const MESSAGE_LITERAL_RE = /message:\s*(`[^`]*`|"[^"]*"|'[^']*')/;
// The raw error/path must still be logged server-side (debug evidence preserved).
const META_WARNING_LOG_RE =
  /console\.warn\(\s*`\[explore\] search metadata unavailable for [^`]*\$\{describeError\(err\)\}`/;
const CURSOR_WARNING_LOG_RE =
  /console\.warn\(\s*`\[explore\] most-recent ordering failed for [^`]*\$\{describeError\(err\)\}`/;
const PEEK_WARNING_LOG_RE = /console\.warn\(\s*`\[explore\] peek read failed for [^`]*\$\{peek\.error\}`/;

function messageForWarningCode(source: string, code: string): string {
  const codeLineRe = new RegExp(`code:\\s*"${code}"`);
  const codeMatch = codeLineRe.exec(source);
  assert.ok(codeMatch, `warning code "${code}" must be present in the assembler`);
  // Take the slice starting at the code match and grab the first `message:` line.
  const rest = source.slice(codeMatch.index);
  const messageMatch = MESSAGE_LITERAL_RE.exec(rest);
  const messageLiteral = messageMatch?.[1];
  assert.ok(messageLiteral, `warning "${code}" must have a message string`);
  return messageLiteral;
}

test("honesty-copy: sibling WarningList messages carry no engine vocabulary or raw-error leak", async () => {
  const assembler = await readFile(ASSEMBLER_FILE, "utf8");
  for (const code of WARNING_CODES_UNDER_GUARD) {
    const message = messageForWarningCode(assembler, code);
    assert.doesNotMatch(
      message,
      IMPL_NOUN_RE,
      `warning "${code}" message must NOT leak implementation/engine nouns to the owner: ${message}`
    );
    assert.doesNotMatch(
      message,
      RAW_ERROR_INTERP_RE,
      `warning "${code}" message must NOT interpolate the raw error / internal path: ${message}`
    );
  }
});

test("honesty-copy: the raw error for sibling warnings is preserved as server-side debug evidence", async () => {
  const assembler = await readFile(ASSEMBLER_FILE, "utf8");
  // Each fixed warning still logs its raw error/path server-side so debugging
  // does not regress — the detail simply moved out of the rendered message.
  assert.match(
    assembler,
    META_WARNING_LOG_RE,
    "search_meta_warning must still log describeError(err) via console.warn"
  );
  assert.match(
    assembler,
    CURSOR_WARNING_LOG_RE,
    "search_cursor_unavailable must still log describeError(err) via console.warn"
  );
  assert.match(assembler, PEEK_WARNING_LOG_RE, "peek_unreachable must still log peek.error via console.warn");
});

test("Explore rows show one human context line and a sans relative time", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  const css = await readFile(EXPLORE_CSS_FILE, "utf8");
  const sharedCss = await readFile(COMPONENTS_CSS_FILE, "utf8");
  const inspector = await readFile(RECORD_INSPECTOR_FILE, "utf8");

  // Explore brief decision 5 and DIRECTION.md "Rows, not boxes": each record is one opening row.
  assert.match(src, CANVAS_RECORD_ROW_HELPER_RE, "rows use the shared human display values");
  assert.match(src, CANVAS_ROW_CONTEXT_RE, "rows show the kind and data source on one line");
  assert.match(src, ROW_TIME_TEXT_RE, "rows show one time value");
  assert.match(css, ROW_TIME_CSS_RE, "row time uses the sans face and secondary type");
  assert.match(src, DESKTOP_ROW_PEEK_ONCLICK_RE, "the whole desktop row opens the inspector");
  assert.match(src, MOBILE_ROW_LABEL_OWNS_ACTION_RE, "the phone row opens its full record");
  assert.match(inspector, INSPECTOR_OPEN_FULL_RECORD_RE, "the full record remains reachable in Details");
  assert.doesNotMatch(src, CANVAS_NO_EXTRA_ROW_CONTROLS_RE, "rows have no inspect control or extra snippet");

  assert.match(src, UPCOMING_USES_SERVER_RE, "the canvas renders the server's upcoming records");
  assert.match(src, UPCOMING_TOTAL_FROM_SERVER_RE, "upcoming count comes from the server");
  assert.doesNotMatch(src, UPCOMING_NO_CLIENT_PARTITION_RE, "the client does not repartition upcoming records");
  assert.match(src, UPCOMING_SECTION_RENDER_RE, "upcoming records remain reachable in their section");
  assert.match(sharedCss, UPCOMING_CSS_RE, "the upcoming section retains its control treatment");
  assert.match(src, DESKTOP_ROW_DATA_SELECTED_RE, "desktop row selection remains machine-readable");
  assert.match(src, MOBILE_ROW_LABEL_OWNS_ACTION_RE, "phone row links identify their destination");
  assert.match(sharedCss, SEARCH_HEADER_CSS_RE, "search title and escape controls retain their layout");
});

// Explore brief decision 5: the desktop row opens the inspector; the full record remains in Details.
test("Explore desktop row peeks and the full record stays reachable in Details", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  const inspector = await readFile(RECORD_INSPECTOR_FILE, "utf8");
  assert.match(src, DESKTOP_ROW_PEEK_ONCLICK_RE, "the desktop row button opens the peek");
  assert.match(src, CANVAS_RECORD_HREF_RE, "the full record destination is computed");
  assert.match(inspector, INSPECTOR_OPEN_FULL_RECORD_RE, "the full record link is in Details");
});

test("Slice 3: focused/selected row is machine-readable (aria-pressed + data-selected) and visible", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  const css = await readFile(COMPONENTS_CSS_FILE, "utf8");
  // The desktop row is a toggle button: aria-pressed is its valid ARIA selected
  // state; data-selected is the machine-readable flag the contract requires.
  assert.match(src, DESKTOP_ROW_ARIA_PRESSED_RE, "the selected row must expose aria-pressed (toggle-button state)");
  assert.match(src, DESKTOP_ROW_DATA_SELECTED_RE, "the selected row must also expose data-selected (machine-readable)");
  // A visible selected fill/ring + a keyboard focus-visible ring must exist.
  assert.match(css, ROW_SELECTED_CSS_RE, "the selected row must have a visible selected treatment");
  assert.match(css, ROW_FOCUS_VISIBLE_CSS_RE, "the focused row must have a visible focus ring");
});

test("Slice 3: keyboard contract — Enter peeks, Cmd/Ctrl-Enter opens the full route, Escape clears", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  // Arrow up/down move the selection (already pinned via onArrow); here we pin the
  // Enter (peek) / Cmd-Ctrl-Enter (full route) / Escape (clear) leg of the contract.
  assert.match(src, ROW_KEYBOARD_USES_RESOLVER_RE, "the row keyboard handler must route through resolveRowKeyAction");
  assert.match(src, ROW_KEYBOARD_ARROW_DOWN_RE, "ArrowDown must move the selection forward");
  assert.match(src, ROW_KEYBOARD_ARROW_UP_RE, "ArrowUp must move the selection backward");
  assert.match(src, ROW_KEYBOARD_PEEK_RE, "Enter (peek) must open the in-place inspect via onSelect");
  assert.match(
    src,
    ROW_KEYBOARD_OPEN_FULL_RE,
    "Cmd/Ctrl-Enter (open-full) must escalate to the full record route via onOpenFull"
  );
  assert.match(src, ROW_KEYBOARD_CLEAR_RE, "Escape (clear) must clear the selection/peek via onClearSelection");
});

test("Slice 3 (#3): the redundant feed-level 'inspect read request' disclosure is removed; copy-view-link remains", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  // The replacement ("copy view link") MUST exist before the redundant affordance
  // is removed (review red line: remove only after the replacement is proven).
  assert.match(src, COPY_VIEW_LINK_RE, "the single share affordance 'copy view link' must remain in the canvas");
  assert.doesNotMatch(
    src,
    INSPECT_READ_REQUEST_RE,
    "the redundant feed-level 'inspect read request' disclosure must be gone (#3)"
  );
});

test("Slice 3: multi-select is explicitly NOT added (no checkbox column, no bulk-select state)", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  assert.doesNotMatch(src, MULTI_SELECT_CHECKBOX_RE, "Explore must not introduce a multi-select checkbox column");
  assert.doesNotMatch(src, MULTI_SELECT_STATE_RE, "Explore must not introduce bulk multi-select state");
});

test("Explore keeps record-id navigation and uses one honest count line", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  const presentation = await import("./explore-presentation.ts");
  assert.match(src, GO_TO_RECORD_LABEL_RE, "Explore labels record-id navigation");
  assert.match(src, GO_TO_RECORD_SCOPED_RE, "record-id navigation opens the scoped record page");
  assert.match(src, GO_TO_RECORD_UNSCOPED_RE, "record-id navigation searches without a single kind selected");
  assert.match(src, GO_TO_RECORD_FEEDBACK_RE, "record-id navigation reports exact-match outcomes");
  assert.match(src, CANVAS_COUNT_HELPER_CALL_RE, "the heading count uses only the current total or loaded page");
  assert.equal(presentation.exploreCountLine({ exactTotal: 42, pageCount: 32 }), "42 records");
  assert.equal(presentation.exploreCountLine({ exactTotal: null, pageCount: 32 }), "Showing the newest 32");
  assert.match(src, FULL_STREAM_WHOLE_STREAM_NOTE_RE, "the full list explains that Explore-only filters stay here");
});

test("Explore controls expose state and bounded-search truth", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  const assembler = await readFile(ASSEMBLER_FILE, "utf8");
  const inspector = await readFile(RECORD_INSPECTOR_FILE, "utf8");

  assert.match(assembler, SEARCH_HAS_MORE_RE, "search has_more must make the Explore page visibly bounded");
  assert.match(src, FACET_ARIA_PRESSED_RE, "connection and stream chips must expose selected state");
  assert.match(src, SORT_NEWEST_ARIA_RE, "the newest sort control must expose selected state");
  assert.match(src, SORT_OLDEST_ARIA_RE, "the oldest sort control must expose selected state");
  assert.match(
    src,
    DATE_PRESET_ARIA_CHECKED_RE,
    "the single Date chip's presets must expose selected state (radio-group aria-checked)"
  );
  assert.match(inspector, RAW_JSON_DISCLOSURE_RE, "the Explore inspector must expose raw JSON as supporting detail");
});

test("Slice 5 (#2): the mobile loading indicator is pinned to the TOP of the visible feed, not above the fold", async () => {
  const css = await readFile(COMPONENTS_CSS_FILE, "utf8");
  assert.match(
    css,
    MOBILE_PROGRESS_FIXED_RE,
    "on phones (≤860px) the route-progress bar must be position:fixed; top:0 so it sits at the top of the visible viewport"
  );
  assert.match(
    css,
    DESKTOP_PROGRESS_ABSOLUTE_RE,
    "the desktop base rule must stay position:absolute (top of the canvas) — the mobile fixed rule is an override"
  );
});

test("Slice 5 (#2, review red line): loading does NOT dim or disable already-readable records", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  // The feed region's only pending signal is aria-busy; it is never given an
  // opacity dim or a pointer-events block keyed on the pending state.
  assert.match(src, FEED_NO_DIM_RE, "the feed region must carry aria-busy as its only pending signal");
  assert.doesNotMatch(
    src,
    FEED_PENDING_DIM_RE,
    "loading must not gate feed opacity or pointer-events on isPending — readable records stay live"
  );
});

test("Slice 5 (#6): the operators/typeahead popover stays within the viewport (pure-CSS clamp, no JS measurement)", async () => {
  const css = await readFile(COMPONENTS_CSS_FILE, "utf8");
  assert.match(
    css,
    TYPEAHEAD_VIEWPORT_CLAMP_RE,
    "the typeahead must be left:0/right:0 anchored to the input AND clamped by max-width:100vw + max-height:min(280px,60vh) + overflow-y:auto so it never runs off-screen"
  );
  // Mobile override: the options popover (operator-syntax legend) also becomes a
  // full-width sheet to match DateChip's mobile pattern, preventing leftward overflow
  // when the trigger wraps near the left edge on narrow screens.
  assert.match(
    css,
    OPTIONS_VIEWPORT_CLAMP_RE,
    "the options popover must have a mobile override with right:0 + left:0 + width:auto + max-width:none to become a full-width sheet and prevent overflow"
  );
});

test("Slice 5 (#7): expansion/load-more motion is reduced-motion gated with a static fallback and causes no layout shift", async () => {
  const css = await readFile(COMPONENTS_CSS_FILE, "utf8");
  // Base rule (outside any media query) = static, fully-visible fallback.
  assert.match(
    css,
    REVEAL_STATIC_FALLBACK_RE,
    "the reveal targets must have a static opacity:1/transform:none base rule (reduced-motion users see content immediately)"
  );
  // The animation lives ONLY inside @media (prefers-reduced-motion: no-preference).
  assert.match(
    css,
    REVEAL_GATED_BEHIND_NO_PREFERENCE_RE,
    "the rr-x-reveal animation must live only inside @media (prefers-reduced-motion: no-preference)"
  );
  // The keyframe animates ONLY opacity + transform → no width/height/margin reflow.
  assert.match(
    css,
    REVEAL_KEYFRAME_TRANSFORM_OPACITY_ONLY_RE,
    "rr-x-reveal must animate only opacity + transform (no width/height/margin) so there is zero layout shift"
  );
  // The canvas wraps expanded burst rows in the reveal container.
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  assert.match(
    src,
    BURST_REVEAL_WRAPPER_RE,
    "expanded burst rows must be wrapped in the rr-x-burst__rows reveal container"
  );
});

test("Slice 5 (#7): selection motion is a paint-only token transition (no layout shift, collapses under reduced motion)", async () => {
  const css = await readFile(COMPONENTS_CSS_FILE, "utf8");
  assert.match(
    css,
    SELECTION_TRANSITION_RE,
    "the row must transition background + box-shadow via state duration/easing tokens (paint-only → no reflow; duration zeroes under reduced motion)"
  );
});

// review red line (no NEW keyframe escapes the reduced-motion gate): every
// @keyframes the Explore canvas drives is paired with a no-preference media gate
// AND a static fallback. We assert the THREE Explore keyframes (the two from the
// loading-states slice + the new reveal) are all referenced only inside
// no-preference blocks. A new bare `animation:` outside such a block would be a
// regression this test catches by construction.
const EXPLORE_KEYFRAME_NAMES = ["rr-x-progress-slide", "rr-x-row-pending-sweep", "rr-x-reveal"];
const SPIN_FADE_BASE_KEYFRAMES = ["spin", "fade-in"]; // base.css keyframes reused here

test("Slice 5: every Explore animation reference sits inside a prefers-reduced-motion:no-preference block", async () => {
  const css = await readFile(COMPONENTS_CSS_FILE, "utf8");
  // Split the file into no-preference blocks vs the rest by walking brace depth
  // from each `@media (prefers-reduced-motion: no-preference) {` to its matching
  // close. Any `animation:` declaration OUTSIDE those blocks must NOT reference one
  // of the Explore/loading keyframes (those are motion that must be gated).
  const GATED_KEYFRAMES = [...EXPLORE_KEYFRAME_NAMES, ...SPIN_FADE_BASE_KEYFRAMES];
  const noPrefRanges: [number, number][] = [];
  const opener = "@media (prefers-reduced-motion: no-preference) {";
  let idx = css.indexOf(opener);
  while (idx !== -1) {
    let depth = 0;
    let i = idx + opener.length - 1; // start at the opening brace
    let end = css.length;
    for (; i < css.length; i += 1) {
      if (css[i] === "{") {
        depth += 1;
      } else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    noPrefRanges.push([idx, end]);
    idx = css.indexOf(opener, end);
  }
  const inNoPref = (pos: number) => noPrefRanges.some(([s, e]) => pos >= s && pos <= e);

  // Find every `animation:` declaration that references a gated keyframe and assert
  // it lives inside a no-preference block. (Pure transitions via the state tokens are
  // fine ungated — they collapse to an instant cut under the base.css duration
  // reset — so we only check keyframe-driven `animation:` here.)
  const animationDeclRe = /animation:\s*[^;]+;/g;
  for (const m of css.matchAll(animationDeclRe)) {
    const [decl] = m;
    const referencesGated = GATED_KEYFRAMES.some((k) => decl.includes(k));
    if (referencesGated) {
      assert.ok(
        inNoPref(m.index ?? 0),
        `animation referencing a gated keyframe must be inside a prefers-reduced-motion:no-preference block: ${decl.trim()}`
      );
    }
  }
});

// ─── D2 relayout: conditional inspector column (review-required 8.4) ────────────
//
// The `.rr-x` DEFAULT grid is 2-col (rail | feed) — it must NOT reserve the 420px
// inspector column. The 420px inspector track appears ONLY under `.rr-x.has-selection`
// (a record peeked). This is the source-of-truth for "no dead canvas / no query-bar
// overlap when nothing is selected." Source-regex against the actual CSS + the canvas
// JSX that wires the class from `data.peek`.

// The base `.rr-x { ... }` rule body — a bare `.rr-x` selector, NOT `.has-selection`,
// `.rr-x-...`, or `.rr-x:...` (the leading `(^|\})` boundary excludes `.rr-x-foo`).
const BASE_RRX_RULE_RE = /(^|\})\s*\.rr-x\s*\{([^}]*)\}/m;
const BASE_RRX_TWO_COL_RE = /grid-template-columns:\s*230px\s+minmax\(0,\s*1fr\);/;
const RRX_420PX_RE = /420px/;
const RRX_HAS_SELECTION_THREE_COL_RE =
  /\.rr-x\.has-selection\s*\{\s*grid-template-columns:\s*230px\s+minmax\(0,\s*1fr\)\s+420px;\s*\}/;
const RRX_EMPTY_INSPECTOR_HIDDEN_RE = /\.rr-x:not\(\.has-selection\)\s*>\s*\.rr-inspector\s*\{\s*display:\s*none;\s*\}/;
const RRX_1280_RESETS_BOTH_RE =
  /@media \(max-width: 1280px\) \{[\s\S]*?\.rr-x,\s*\.rr-x\.has-selection \{\s*grid-template-columns:\s*200px\s+minmax\(0,\s*1fr\);/;
const HAS_SELECTION_DERIVES_FROM_PEEK_RE = /const hasSelection = data\.peek !== null && data\.peek !== undefined;/;
const HAS_SELECTION_CLASS_WIRING_RE = /className=\{hasSelection \? "rr-x explore-page has-selection" : "rr-x explore-page"\}/;
const BURST_VISIBLE_ENTRIES_PREVIEW_RE = /const visibleEntries = expanded \? burst\.entries : burst\.preview;/;
const BURST_HEAD_LEFT_ALIGN_RE = /\.rr-x-burst__head \{[\s\S]*?text-align:\s*left;/;
const ROW_TITLE_ELLIPSIS_CSS_RE =
  /\.explore-page \.rr-x-row__title \{[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/;
const ROW_META_ELLIPSIS_CSS_RE =
  /\.explore-page \.rr-x-row__meta \{[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/;

/** Extract the body of the BASE `.rr-x { ... }` rule (top-level, not a media query). */
function baseRrxRuleBody(css: string): string {
  const m = css.match(BASE_RRX_RULE_RE);
  assert.ok(m, "base .rr-x rule must exist");
  return m?.[2] ?? "";
}

test("8.4: the base .rr-x grid is 2-col (NO reserved 420px inspector); the 420px column appears only under .rr-x.has-selection", async () => {
  const css = await readFile(COMPONENTS_CSS_FILE, "utf8");

  // The base .rr-x rule must declare a 2-column grid and must NOT carry the 420px
  // inspector track. (A bare `.rr-x` selector body — not `.has-selection`.)
  const baseBody = baseRrxRuleBody(css);
  assert.match(baseBody, BASE_RRX_TWO_COL_RE, "default .rr-x is 2-col rail|feed — the feed claims the freed width");
  assert.doesNotMatch(
    baseBody,
    RRX_420PX_RE,
    "default .rr-x must NOT reserve the 420px inspector column (dead-canvas + overlap root cause)"
  );

  // The 420px inspector track is gated behind `.rr-x.has-selection`.
  assert.match(
    css,
    RRX_HAS_SELECTION_THREE_COL_RE,
    ".rr-x.has-selection must add the 420px inspector as the 3rd column"
  );

  // With no selection the empty inspector placeholder must not occupy a column.
  assert.match(
    css,
    RRX_EMPTY_INSPECTOR_HIDDEN_RE,
    "no-selection state hides the empty inspector so it never reserves/forces a column"
  );

  // Responsive overrides must collapse the selected 3-col track too (specificity:
  // `.rr-x.has-selection` (0,2,0) outranks a bare `.rr-x` (0,1,0) in a media query,
  // so the override must name `.rr-x.has-selection` explicitly or a selected record
  // would keep forcing the 420px track below 1280).
  assert.match(
    css,
    RRX_1280_RESETS_BOTH_RE,
    "≤1280 must reset BOTH .rr-x and .rr-x.has-selection to 2-col (stacked inspector)"
  );
});

test("8.4 (wiring): the canvas adds .has-selection to the .rr-x root ONLY when a record is peeked (data.peek)", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  // Selection truth = data.peek != null, applied as the has-selection class.
  assert.match(
    src,
    HAS_SELECTION_DERIVES_FROM_PEEK_RE,
    "selection state derives from data.peek (the URL-addressable peek), the single source of truth"
  );
  assert.match(src, HAS_SELECTION_CLASS_WIRING_RE, "the .rr-x root gets has-selection only when a record is peeked");
});

test("D1 render contract: the BurstRow renders burst.preview (collapsed) so a burst is never a content-less header", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  // The renderer must show burst.preview when collapsed and burst.entries when expanded.
  assert.match(
    src,
    BURST_VISIBLE_ENTRIES_PREVIEW_RE,
    "collapsed burst renders preview rows (content-by-default), expanded renders all"
  );
  assert.match(src, BURST_REVEAL_WRAPPER_RE, "burst rows mount inside the rr-x-burst__rows reveal container");
  // The left-aligned burst head + toggle must be styled (F6 center-alignment fix).
  const css = await readFile(COMPONENTS_CSS_FILE, "utf8");
  assert.match(css, BURST_HEAD_LEFT_ALIGN_RE, "burst head is left-aligned (not centered) — the F6 defect");
});

test("Explore feed row title and context lines truncate within the viewport", async () => {
  const css = await readFile(EXPLORE_CSS_FILE, "utf8");
  // Explore brief decision 5: one title and one second-text line must remain readable on a phone.
  assert.match(css, ROW_TITLE_ELLIPSIS_CSS_RE, "the row title truncates instead of widening the page");
  assert.match(css, ROW_META_ELLIPSIS_CSS_RE, "the kind/source line truncates instead of widening the page");
});

// ─── Enter-hijack (re-walk F3): the typeahead must NOT auto-highlight a suggestion ──
// Typing a multi-word query + Enter must run the LITERAL search, not silently apply the
// first name-matching facet. The combobox opens with NOTHING highlighted (cursor === -1),
// Enter picks a suggestion ONLY when the owner explicitly arrowed into one (cursor >= 0),
// and every keystroke resets the cursor to no-highlight. These guards pin that the old
// `setCursor(0)` auto-highlight (which caused the hijack) is not re-introduced.
const TYPEAHEAD_NO_HIGHLIGHT_CONST_RE = /const NO_HIGHLIGHT = -1;/;
const TYPEAHEAD_CURSOR_STARTS_UNSET_RE = /useState\(NO_HIGHLIGHT\)/;
const TYPEAHEAD_ONCHANGE_RESETS_UNSET_RE = /setMenuOpen\(true\);\s*(?:\/\/[^\n]*\n\s*)*setCursor\(NO_HIGHLIGHT\);/;
const TYPEAHEAD_ENTER_GUARDS_EXPLICIT_HIGHLIGHT_RE =
  /const picked = menuOpen && cursor >= 0 && cursor < suggestions\.length \? suggestions\[cursor\] : null;/;
// The old auto-highlight that caused the hijack MUST be gone from the onChange handler.
const TYPEAHEAD_NO_AUTO_HIGHLIGHT_RE = /setMenuOpen\(true\);\s*setCursor\(0\);/;

test("F3 Enter-hijack: the typeahead opens with no highlight and Enter on free text runs the literal search", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  assert.match(src, TYPEAHEAD_NO_HIGHLIGHT_CONST_RE, "a NO_HIGHLIGHT (-1) sentinel exists");
  assert.match(src, TYPEAHEAD_CURSOR_STARTS_UNSET_RE, "the cursor state starts at NO_HIGHLIGHT, not 0");
  assert.match(
    src,
    TYPEAHEAD_ONCHANGE_RESETS_UNSET_RE,
    "typing resets the cursor to NO_HIGHLIGHT (no auto-selected first suggestion)"
  );
  assert.match(
    src,
    TYPEAHEAD_ENTER_GUARDS_EXPLICIT_HIGHLIGHT_RE,
    "Enter picks a suggestion ONLY when the owner explicitly arrowed into one (cursor >= 0)"
  );
  assert.doesNotMatch(
    src,
    TYPEAHEAD_NO_AUTO_HIGHLIGHT_RE,
    "the old setCursor(0) auto-highlight (the Enter-hijack cause) must NOT be re-introduced"
  );
});

// ─── Zero-results "Remove source filter" escape action: HONEST id match (review HOLD) ──
// The remove-source escape action must remove the connection by EXACT connection-id
// equality (derived from the chip's `con:<id>` id), never by a substring match on the
// chip's DISPLAY VALUE. A display name like "Chase - Personal" is not a substring of its
// id `cin_chase`, so the old `connectionIds.filter(id => !id.includes(lastChip.value...))`
// would claim to remove the filter but navigate to a still-filtered view — a count==
// reachability/honesty violation. Pin the honest exact-id removal; forbid the substring bug.
const ZERO_REMOVE_SOURCE_EXACT_ID_RE =
  /lastChip\.id\.slice\("con:"\.length\)[\s\S]*?connectionIds:\s*removedId\s*\?\s*s\.connectionIds\.filter\(\(id\)\s*=>\s*id\s*!==\s*removedId\)/;
const ZERO_REMOVE_SOURCE_SUBSTRING_BUG_RE = /connectionIds\.filter\(\(id\)\s*=>\s*!id\.includes\(lastChip\.value/;

test("zero-results remove-source escape removes the connection by EXACT id, not a display-name substring (review HOLD fix)", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  assert.match(
    src,
    ZERO_REMOVE_SOURCE_EXACT_ID_RE,
    "the remove-source escape action must filter connectionIds by exact id (from the chip's con: prefix)"
  );
  assert.doesNotMatch(
    src,
    ZERO_REMOVE_SOURCE_SUBSTRING_BUG_RE,
    "the display-name substring match (lastChip.value in id.includes) must NOT be reintroduced — it can leave a filter applied while claiming to remove it"
  );
});

test("Explore count copy never labels a page count as a total", async () => {
  const src = await readFile(EXPLORE_CANVAS_FILE, "utf8");
  const presentation = await import("./explore-presentation.ts");
  // Explore brief decision 1: page counts are labelled as newest rows, and the old Views count is gone.
  assert.match(src, CANVAS_COUNT_LINE_RE);
  assert.doesNotMatch(src, CANVAS_NO_OLD_VIEWS_COUNT_RE);
  assert.equal(presentation.exploreCountLine({ exactTotal: null, pageCount: 7 }), "Showing the newest 7");
});
