// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guards for the Grants list page.
 *
 * Grants are an owner-comprehension surface: row copy may preserve raw
 * client_id as hover/identity detail, but the visible caption must not lead
 * with `client cli_...` technical ids when registered client metadata exists.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const PENDING_APPROVAL_ROW_FILE = `${HERE}pending-approval-row.tsx`;
// The caption helpers moved to a shared module so grant-packages pages could
// reuse them instead of re-inlining the same raw-client_id-avoidance logic.
const CLIENT_CAPTION_FILE = `${HERE}client-caption.ts`;

const PAGE_USES_CLIENT_CAPTION_RE = /clientCaption\(grant\)/;
const CLIENT_CAPTION_HELPER_RE = /export function clientCaption\(/;
const TECHNICAL_CLIENT_CAPTION_HELPER_RE = /export function technicalClientCaption\(/;
const CLIENT_ORIGIN_CAPTION_HELPER_RE = /export function clientOriginCaption\(/;
const RAW_CLIENT_CAPTION_RE = /client\s+\{grant\.client_id\}/;
const RAW_APPROVAL_CLIENT_ID_RE = /client\s+\{approval\.client_id/;

// C6: the Pending approvals section collapses entirely at zero — it must be
// gated on a non-empty length, never rendered unconditionally with an
// empty-state at the top of the grants list.
const PENDING_SECTION_GATED_RE = /approvals\.data\.length > 0 \? \(\s*<Section/;
const PENDING_EMPTY_STATE_IMPORT_RE = /EmptyState/;

test("grants list formats visible client captions instead of rendering raw client ids", async () => {
  const pageSrc = await readFile(PAGE_FILE, "utf8");
  const pendingApprovalRowSrc = await readFile(PENDING_APPROVAL_ROW_FILE, "utf8");
  const captionSrc = await readFile(CLIENT_CAPTION_FILE, "utf8");
  assert.match(pageSrc, PAGE_USES_CLIENT_CAPTION_RE);
  // apps-repair.md P2: waiting requests use the best available app name.
  assert.match(pageSrc, /appName=\{pendingApprovalAppName\(clientNames\.get/);
  assert.match(pendingApprovalRowSrc, /<p className="text-\[15px\] font-medium text-foreground">\{appName\}<\/p>/);
  // RAISE-RULES 4: an unrecognized app id is available only inside folded Details.
  assert.match(pendingApprovalRowSrc, /<details[\s\S]*App id: \{approval\.client_id\}[\s\S]*<\/details>/);
  assert.match(captionSrc, CLIENT_CAPTION_HELPER_RE);
  assert.match(captionSrc, TECHNICAL_CLIENT_CAPTION_HELPER_RE);
  assert.match(captionSrc, CLIENT_ORIGIN_CAPTION_HELPER_RE);
  assert.doesNotMatch(pageSrc, RAW_CLIENT_CAPTION_RE);
  assert.doesNotMatch(pendingApprovalRowSrc, RAW_APPROVAL_CLIENT_ID_RE);
});

test("grants page collapses the Pending approvals section when there are zero pending", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The Section is rendered only inside a `length > 0` guard...
  assert.match(src, PENDING_SECTION_GATED_RE);
  // ...and the empty-state placeholder is no longer used (nothing renders at zero).
  assert.doesNotMatch(src, PENDING_EMPTY_STATE_IMPORT_RE);
});

test("the packages list stays reachable from the page heading", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // DIRECTION.md §The frame and the menu: keep every current address reachable; the Apps page keeps Packages in Details.
  assert.match(src, /href="\/grants\/packages">Packages/);
});

test("Apps only shows useful top filters and keeps duplicate app filters out of Details", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // apps-repair.md P2: hide filters for zero or one app, use named placeholders, and do not repeat them in Details.
  assert.match(src, /const apps = groupGrantAccessByApp\(result\.data\)/);
  assert.match(src, /apps\.length > 1 \|\| appFiltersSet \? <form/);
  // Deputy repair: a filter that leaves one app or none must not hide the filters and Clear filters.
  assert.match(src, /const appFiltersSet = Boolean\(params\.client_id \|\| params\.source_kind \|\| params\.source_id\)/);
  assert.match(src, /placeholder="All apps"/);
  assert.match(src, /placeholder="All kinds"/);
  assert.match(src, /placeholder="All data sources"/);
  assert.doesNotMatch(src, /label: "All apps", value: ""/);
  assert.doesNotMatch(src, /label: "All kinds", value: ""/);
  assert.doesNotMatch(src, /label: "All data sources", value: ""/);
  const details = src.slice(src.indexOf("<details"));
  assert.doesNotMatch(details, /<IcSelect[^>]*name="client_id"/);
  assert.doesNotMatch(details, /<IcSelect[^>]*name="source_kind"/);
  assert.doesNotMatch(details, /<IcSelect[^>]*name="source_id"/);
  assert.match(src, /name="client_id"/);
  assert.match(src, /name="source_kind"/);
  assert.match(src, /name="source_id"/);
  assert.match(src, /<AppAccessList/);
});

test("the inert previous pager and unconfigured timeline load-more control are absent", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // RAISE-RULES 1: remove proven-dead controls from this list and keep the live next-page link.
  assert.doesNotMatch(src, /←\s*previous/i);
  assert.doesNotMatch(src, /load more timeline events/i);
  assert.doesNotMatch(src, /loadMoreHref=/);
  assert.match(src, /result\.has_more && result\.next_cursor/);
});

test("empty demo state renders without server reads", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // RAISE-RULES 8: keep a no-server empty sample state for the page.
  assert.match(src, /const demoMode = process\.env\.NODE_ENV !== "production"[\s\S]*params\.demo === "empty"/);
  assert.match(src, /connectorManifests = demoMode \? \[\]/);
  assert.match(src, /params\.demo === "empty" \? demo\.buildEmptyGrantsDemoData\(\)/);
});

test("app removal is offered only on the full list, and Details opens when its own controls are in use", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // RAISE-RULES 3 / logic: a partial list cannot remove "the app", it would leave the rest of its access.
  assert.match(src, /const listNarrowed = Boolean\(params\.cursor \|\| params\.q \|\| params\.status \|\| params\.source_kind \|\| params\.source_id\)/);
  assert.match(src, /canRemove=\{!\(result\.has_more \|\| listNarrowed\)\}/);
  // A peek, next page, search or state filter lives in Details; it must not reload folded.
  assert.match(src, /open=\{Boolean\(params\.peek \|\| params\.cursor \|\| params\.q \|\| params\.status\)\}/);
});

test("the Apps list keeps stopped access out of the readable apps group and omits the owner sign-in hint", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // Round 6 item 3: stopped access is split from apps that can read.
  assert.match(src, /splitAppAccessGroups\(apps\)/);
  // DIRECTION.md, Home § Apps that can read your data: the readable group title stays accurate.
  assert.match(src, /title="Apps that can read your data"/);
  // Round 6 item 3: stopped access has its own group.
  assert.match(src, /title="Access stopped"/);
  // PAGE-RULES 6: the Apps detail label says "data source".
  assert.match(src, /data source \{appSourceName\(grant\.source\)\}/);
  // Round 6 item 4: the signed-in owner is not told to sign in again.
  assert.doesNotMatch(src, /If you need to sign in before reviewing/);
});
