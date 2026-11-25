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

test("Apps groups the existing grant read into app rows and keeps its three filters visible", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // DIRECTION.md §Home: apps are presented as one row per app with the data sources it can read.
  assert.match(src, /groupGrantAccessByApp\(result\.data\)/);
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
