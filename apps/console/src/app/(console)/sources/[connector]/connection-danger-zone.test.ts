// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural coverage for the console connection danger zone (revoke + delete).
 *
 * Like `rename-connection.test.ts` / `cancel-run-control.test.ts`, the control
 * is a client component with hooks and this app has no JSX render harness (no
 * jsdom / testing-library). So we assert — via source regex — that the wiring
 * matches the `add-console-connection-revoke-delete-controls` contract:
 *
 *   - the danger zone renders only on the connection detail page, which resolves
 *     a concrete configured connection (catalog-only / unavailable rows
 *     `notFound()` before reaching it), so destructive controls never attach to
 *     a catalog row; a connector type with no addressable connection renders
 *     disabled guidance, not destructive forms;
 *   - revoke copy says sources/grants are retained and only future collection
 *     stops, and does NOT claim records are erased;
 *   - delete copy says this connection's records are permanently erased and
 *     cannot be recovered, says plainly that granted apps stay authorized and
 *     stop receiving this source's data, and no longer claims a default-account
 *     refusal (default-account connections are deletable);
 *   - when a run blocks the delete, the same confirmed form cancels that run
 *     (`cancel_run_id`) and the action retries the delete;
 *   - delete requires reproducing the connection id before the destructive
 *     submit enables (client gating) AND the server action enforces the same
 *     (`confirm_delete === connection_id`), revoke enforces `confirm_revoke`;
 *   - the server actions call the shared owner-session client wrappers
 *     (`revokeConnection` / `deleteConnection`), not a duplicate cascade, and
 *     re-verify dashboard access + revalidate.
 *
 * This file imports no app code (source-regex only), so it runs under the
 * `node:test` `run({files})` API with native type-stripping even from the
 * bracketed `[connector]` directory.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DANGER_ZONE_FILE = `${HERE}connection-danger-zone.tsx`;
const ACTIONS_FILE = `${HERE}actions.ts`;
const PAGE_FILE = `${HERE}source-page.tsx`;

const PAGE_RESOLVES_CONNECTION_RE = /resolveConnectionForRecordsRoute/;
const PAGE_NOT_FOUND_RE = /notFound\(\)/;
const PAGE_RENDERS_DANGER_ZONE_RE = /<ConnectionDangerZone/;
const PAGE_ADDRESSES_RESOLVED_RE = /connectionId=\{connectorInstanceId \?\? connectionId\}/;
const DZ_CONNECTION_ID_FIELD_RE = /name="connection_id"/;
const DZ_DELETE_ACTION_RE = /action=\{deleteConnectionAction\}/;

const ACT_REVOKE_FN_RE = /export async function revokeConnectionAction/;
const ACT_DELETE_FN_RE = /export async function deleteConnectionAction/;
const ACT_REQUIRE_ACCESS_RE = /requireDashboardAccess/;
const ACT_CONFIRM_REVOKE_RE = /confirm_revoke/;
const ACT_CONFIRM_REVOKE_GUARD_RE = /confirm !== "yes"/;
const ACT_CONFIRM_DELETE_GUARD_RE = /confirm !== connectionId/;
const ACT_CALLS_REVOKE_WRAPPER_RE = /await revokeConnection\(connectionId\)/;
const ACT_CALLS_DELETE_WRAPPER_RE =
  /await deleteConnectionWithRunCancel\(connectionId, cancelRunId, \{ cancelRun, deleteConnection \}\)/;
const ACT_READS_CANCEL_RUN_RE = /formData\.get\("cancel_run_id"\)/;
const ACT_FORWARDS_BLOCKING_RUN_RE = /dangerZoneHref\(routeId, message, error, blockingRunId\)/;
const ACT_REVALIDATE_RE = /revalidatePath\("\/sources"\)/;
const ACT_RUN_ACTIVE_RE = /result\.status === "run_active"/;
const ACT_DEFAULT_ACCOUNT_RE = /result\.status === "default_account"/;
const ACT_DELETE_REDIRECT_LIST_RE =
  /purgeFailed \? recordsListHref\(undefined, deletedMessage, connectionId\) : recordsListHref\(deletedMessage\)/;
const ACT_REVOKE_REDIRECT_LIST_RE =
  /purgeFailed \? recordsListHref\(undefined, message, connectionId\) : recordsListHref\(message\)/;
const ACT_PURGE_FAILED_RE = /purgeFailed = result\.profilePurge\?\.status === "failed";/g;
const ACT_PURGE_SENTENCE_RE = /withPurgeSentence\(message, profilePurgeSentence\(result\.profilePurge\)\)/g;
const ACT_PURGE_RETRY_FN_RE = /export async function purgeBrowserProfileAction/;
const ACT_PURGE_RETRY_WRAPPER_RE = /await purgeConnectionBrowserProfile\(connectionId\)/;
const SOURCES_PAGE_FILE = `${HERE}../page.tsx`;
const LIST_RETRY_FORM_RE = /error && purgeRetryId \?/;
const LIST_RETRY_ACTION_RE = /action=\{purgeBrowserProfileAction\}/;
const LIST_RETRY_LABEL_RE = />\s*Remove saved browser session\s*</;
const LIST_READS_RETRY_PARAM_RE = /purgeRetryId=\{params\.purge_retry\}/;
const ACT_DANGER_ANCHOR_RE = /#danger-zone/;

async function read(file: string): Promise<string> {
  return await readFile(file, "utf8");
}

test("the danger zone is rendered on the resolved connection detail page", async () => {
  const page = await read(PAGE_FILE);
  assert.match(page, PAGE_RESOLVES_CONNECTION_RE);
  assert.match(page, PAGE_NOT_FOUND_RE);
  assert.match(page, PAGE_RENDERS_DANGER_ZONE_RE);
  assert.match(page, PAGE_ADDRESSES_RESOLVED_RE);
});

test("a connector with no addressable connection renders disabled guidance, not destructive forms", async () => {
  const src = await read(DANGER_ZONE_FILE);
  assert.match(src, /connectionId === null \? null/);
});

test("revoke copy retains records, stops future collection, and says it signs out the browser session", async () => {
  const src = await read(DANGER_ZONE_FILE);
  assert.match(src, /Stops checking and signs DataConnect out of/);
  assert.match(src, /Your records stay, and apps that can read them still can/);
});

test("the danger zone says sibling connections keep their own browser sessions", async () => {
  const src = await read(DANGER_ZONE_FILE);
  assert.match(src, /connectionId: string \| null/);
  assert.match(src, /name="connection_id" type="hidden" value=\{connectionId\}/);
});

test("delete and revoke surface a failed browser-session purge and offer the retry on the Sources list", async () => {
  const actions = await read(ACTIONS_FILE);
  assert.equal(actions.match(ACT_PURGE_FAILED_RE)?.length, 2, "both actions read profile_purge");
  assert.equal(actions.match(ACT_PURGE_SENTENCE_RE)?.length, 2, "both actions add the purge sentence");
  assert.match(actions, ACT_PURGE_RETRY_FN_RE);
  assert.match(actions, ACT_PURGE_RETRY_WRAPPER_RE);
  const list = await read(SOURCES_PAGE_FILE);
  assert.match(list, LIST_RETRY_FORM_RE);
  assert.match(list, LIST_RETRY_ACTION_RE);
  assert.match(list, LIST_RETRY_LABEL_RE);
  assert.match(list, LIST_READS_RETRY_PARAM_RE);
});

test("delete copy erases this connection, discloses grants, and offers cancel-run for an in-flight run", async () => {
  const src = await read(DANGER_ZONE_FILE);
  assert.match(src, /Erases every record from/);
  assert.match(src, /This cannot be undone/);
  assert.match(src, /Apps keep any copies they already took/);
  assert.match(src, /Stop the sync and delete/);
  assert.match(src, /name="cancel_run_id"/);
});

test("delete requires reproducing the connection id before the destructive submit enables", async () => {
  const src = await read(DANGER_ZONE_FILE);
  assert.match(src, /const confirmed = neverConnected \|\| typed === displayName/);
  assert.match(src, /name="confirm_delete"\s+type="hidden"\s+value=\{confirmed \? connectionId : ""\}/);
  assert.match(src, /disabled=\{!confirmed\}/);
  assert.match(await read(ACTIONS_FILE), ACT_CONFIRM_DELETE_GUARD_RE);
});

test("lifecycle actions use their group title without a bordered red box", async () => {
  const src = await read(DANGER_ZONE_FILE);
  assert.match(src, />Remove<\/h3>/);
  assert.doesNotMatch(src, /<details|<summary/);
});

test("revoke uses a confirm checkbox and the shared revoke action", async () => {
  const src = await read(DANGER_ZONE_FILE);
  assert.match(src, /action=\{revokeConnectionAction\}/);
  assert.match(src, /name="confirm_revoke" type="hidden" value="yes"/);
  assert.match(src, /open \? \(\s*<ActionQuestion/);
});

test("delete form posts the shared delete action with the connection id", async () => {
  const dz = await read(DANGER_ZONE_FILE);
  assert.match(dz, DZ_DELETE_ACTION_RE);
  assert.match(dz, DZ_CONNECTION_ID_FIELD_RE);
});

test("server actions re-verify access, enforce confirmation server-side, and call the shared wrappers", async () => {
  const actions = await read(ACTIONS_FILE);
  assert.match(actions, ACT_REVOKE_FN_RE);
  assert.match(actions, ACT_DELETE_FN_RE);
  assert.match(actions, ACT_REQUIRE_ACCESS_RE);
  assert.match(actions, ACT_CONFIRM_REVOKE_RE);
  assert.match(actions, ACT_CONFIRM_REVOKE_GUARD_RE);
  assert.match(actions, ACT_CONFIRM_DELETE_GUARD_RE);
  assert.match(actions, ACT_CALLS_REVOKE_WRAPPER_RE);
  assert.match(actions, ACT_CALLS_DELETE_WRAPPER_RE);
  assert.match(actions, ACT_REVALIDATE_RE);
});

test("the delete action surfaces each typed refusal in place rather than a generic boundary", async () => {
  const actions = await read(ACTIONS_FILE);
  assert.match(actions, ACT_RUN_ACTIVE_RE);
  assert.match(actions, ACT_READS_CANCEL_RUN_RE);
  assert.match(actions, ACT_FORWARDS_BLOCKING_RUN_RE);
  assert.match(actions, ACT_DEFAULT_ACCOUNT_RE);
  assert.match(actions, ACT_DELETE_REDIRECT_LIST_RE);
  assert.match(actions, ACT_DANGER_ANCHOR_RE);
});

test("successful revoke redirects to the visible connections list instead of a now-revoked detail URL", async () => {
  const actions = await read(ACTIONS_FILE);
  assert.match(actions, ACT_REVOKE_REDIRECT_LIST_RE);
});

test("Copy everything again is hidden when the source has no records (hasRecords gates the form)", async () => {
  const source = await readFile(DANGER_ZONE_FILE, "utf8");
  assert.match(source, /hasRecords = true,/);
  assert.match(source, /setupFailed \|\| inactive \|\| !hasRecords \? null/);
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, /hasRecords=\{recordTotal\.count !== 0\}/);
});

test("on a rejected key the Manage section does not repeat the top button", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, /topButtonShown=\{sourceStatus\.action\?\.kind === "repair_sign_in"\}/);
  assert.match(page, /if \(setupFailed \|\| topButtonShown\) return null;/);
});
