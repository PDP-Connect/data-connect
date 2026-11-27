// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guard for the owner-facing browser-session setup page.
 *
 * This page is for a normal owner trying to connect a browser-backed source.
 * Operator runbooks, internal browser service names, and repository paths belong
 * in diagnostics/operator surfaces, not in the primary setup journey.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_ONLY_FILE = `${HERE}[connectorId]/page.tsx`;
const BODIES_FILE = fileURLToPath(new URL("../../sources/add/connect-bodies.tsx", import.meta.url));
const CREDENTIAL_FIELDS_FILE = fileURLToPath(new URL("../../sources/add/credential-fields.tsx", import.meta.url));
const START_ROUTE_FILE = `${HERE}[connectorId]/start/route.ts`;
const LAUNCH_PANEL_FILE = `${HERE}[connectorId]/launch/launch-panel.tsx`;
const LAUNCH_START_ROUTE_FILE = `${HERE}[connectorId]/launch/start/route.ts`;

// Design "Sign-in services": the lead says "in a browser you can watch", not "secure browser".
async function readPage(): Promise<string> {
  return `${await readFile(PAGE_ONLY_FILE, "utf8")}\n${await readFile(BODIES_FILE, "utf8")}`;
}
const SIGN_IN_LEAD_RE = /description=\{signInCopy\.lead\(name\)\}/;
const OPERATOR_ARTIFACT_RE = /browser-collector runbook|\bneko\b|n\.eko|hosted Chromium/;
const SERVER_ACTION_TRANSPORT_RE = /startBrowserEnrollmentAction|from "\.\/actions\.ts"|<form action=\{[^}]+Action/;
const POST_ROUTE_TRANSPORT_RE =
  /<form\s+action=\{`\/connect\/browser-session\/\$\{encodeURIComponent\(service\.connectorKey\)\}\/start`\}\s+className="grid gap-4"\s+method="post"\s*>/;
const START_ROUTE_POST_RE = /export async function POST/;
const START_ROUTE_AUTH_RE = /await requireDashboardAccess\(pagePath\(connectorId\)\)/;
const START_ROUTE_ORIGIN_RE = /if \(!originMatchesHost\(request\)\)/;
const START_ROUTE_CONNECTION_FIELD_RE = /readConnectionIdField\(formData\)/;
const START_ROUTE_DISPLAY_NAME_FIELD_RE = /readOptionalDisplayNameField\(formData\)/;
const START_ROUTE_SUPPORTED_BROWSER_RE = /browserConnect\.canAddAccount/;
const START_ROUTE_CREATE_SHELL_RE = /createBrowserEnrollmentShell\(connectorId, \{ displayName \}\)/;
const START_ROUTE_DRAFT_ONE_RE = /draft: draft \? "1" : "0"/;
// DIRECTION.md, “No address changes”: keep the existing handoff to Add when this setup path is unavailable.
const START_ROUTE_UNSUPPORTED_REDIRECT_RE = /\/sources\/add\?error=not-self-service/;
const START_ROUTE_LAUNCH_REDIRECT_RE = /\$\{pagePath\(connectorId\)\}\/launch\?\$\{\w+\.toString\(\)\}/;
const START_ROUTE_FORBIDS_SLOW_RUN_RE = /runConnectionNow/;
const START_ROUTE_OPTIONAL_CREDENTIAL_RE = /remember_sign_in_details/;
const START_ROUTE_CREDENTIAL_CAPTURE_RE = /captureStaticSecretCredential/;
const START_ROUTE_SAFE_CONTEXT_RE = /setupFields/;
const START_ROUTE_NO_SECRET_LOG_RE = /\b(?:console|logger)\.(?:debug|info|log|warn|error)\s*\(/;
const START_ROUTE_NO_SECRET_QUERY_RE = /query\.set\([^)]*(?:password|secret)/iu;
const START_ROUTE_ORIGIN_HELPER_IMPORT_RE = /same-origin-route\.ts/;
const START_ROUTE_REDIRECT_HELPER_RE = /redirectToPublicPath/;
const PAGE_CONNECTION_ID_FIELD_RE = /browser-session-connection-id/;
const LAUNCH_PANEL_FETCH_RE =
  /fetch\(`\/connect\/browser-session\/\$\{encodeURIComponent\(connectorId\)\}\/launch\/start`/;
const LAUNCH_PANEL_RECOVER_RE =
  /fetch\(\s*`\/connect\/browser-session\/\$\{encodeURIComponent\(connectorId\)\}\/launch\/recover\?/;
const LAUNCH_PANEL_LOST_TRANSPORT_RECOVERY_RE = /recoverStartedBrowserRun\(connectorId, connectionId, 6\)/;
// DIRECTION.md, “Words”: keep the failure copy plain and tell the person to try again.
const LAUNCH_PANEL_INLINE_FAILURE_RE = /couldn't be opened/;
const LAUNCH_PANEL_RUNS_FALLBACK_RE = /href="\/sources\/add"/;
const LAUNCH_START_ROUTE_RUN_RE = /runConnectionNow\(connectionId\)/;
const LAUNCH_START_ROUTE_ENROLLMENT_ADMISSION_RE = /runAdmission: "browser_enrollment"/;
const LAUNCH_START_ROUTE_CLEANUP_RE = /abandonBrowserEnrollmentShell\(connectionId\)/;
const LAUNCH_START_ROUTE_JSON_RE = /NextResponse\.json/;
const LAUNCH_RECOVER_ROUTE_FILE = `${HERE}[connectorId]/launch/recover/route.ts`;
const LAUNCH_RECOVER_ROUTE_LIST_RE = /listRuns\(\{ connector_id: connectorId, limit: 50 \}\)/;
const LAUNCH_RECOVER_ROUTE_CONNECTION_MATCH_RE = /run\.connector_instance_id === connectionId/;
const LAUNCH_RECOVER_ROUTE_STREAM_HREF_RE = /\/syncs\/\$\{encodeURIComponent\(run\.run_id\)\}\/stream/;

test("browser-session page does not send owners to operator/browser-service artifacts", async () => {
  const src = await readPage();

  assert.match(src, SIGN_IN_LEAD_RE);
  assert.doesNotMatch(src, OPERATOR_ARTIFACT_RE);
  assert.doesNotMatch(src, /secure browser/i);
});

// Design "Sign-in services": one lead, the account note, one optional name field, one button, and a choice that reveals the fields.
test("browser-session setup page shows the design's pieces and none of the removed ones", async () => {
  const src = await readPage();

  assert.match(src, /browserSignInCapture\(storedCredentialSetup\)/);
  assert.match(src, /<ExistingAccountsNote accounts=\{accounts\} connectorKey=\{service\.connectorKey\} \/>/);
  assert.match(src, /<AccountNameField accounts=\{accounts\} fieldName="display_name" name=\{name\} \/>/);
  assert.match(src, /<NewServiceNote name=\{name\} tier=\{service\.tier\} \/>/);
  assert.match(src, /<OptionalSignIn checkboxName=\{capture\.checkboxName\}/);
  assert.match(src, /repairMode \? `Reconnect \$\{name\}` : signInCopy\.button\(name\)/);
  assert.match(src, /<CannotBeAddedHere connectorKey=\{service.connectorKey\} icon=\{service.icon\} instead=\{why.instead\} name=\{name\} reason=\{why.reason\} \/>/);
  // Removed: "Connection name (optional)", the Details fold, "Create a new account in a secure browser", the second logo.
  assert.doesNotMatch(src, /connectionName|<details|Details|Create a new account|Choose an existing data source|ConnectorMark/);
  assert.doesNotMatch(src, PAGE_CONNECTION_ID_FIELD_RE);
});

test("required manifest capture posts through the credential route and does not echo secret fields", async () => {
  const [page, fields, route] = await Promise.all([
    readPage(),
    readFile(CREDENTIAL_FIELDS_FILE, "utf8"),
    readFile(START_ROUTE_FILE, "utf8"),
  ]);
  assert.match(page, /name="credential_capture_required" type="hidden" value="1"/);
  assert.match(page, /<CredentialFields fields=\{capture\.fields\} idPrefix="sign-in" required \/>/);
  assert.match(fields, /required=\{required && field\.required\}/);
  assert.match(fields, /defaultValue=\{field\.secret \? undefined : field\.defaultValue\}/);
  assert.match(page, /defaultValue: firstValue\(resolvedSearchParams\[`field_\$\{field\.name\}`\]\)/);
  assert.match(route, /formData\.get\("credential_capture_required"\) !== "1"/);
  assert.match(route, /await captureStaticSecretCredential\(/);
});

test("browser-session start uses a normal POST route, not Server Action fetch transport", async () => {
  const src = await readPage();
  const route = await readFile(START_ROUTE_FILE, "utf8");

  assert.doesNotMatch(src, SERVER_ACTION_TRANSPORT_RE);
  assert.match(src, POST_ROUTE_TRANSPORT_RE);
  assert.match(route, START_ROUTE_POST_RE);
});

test("browser-session start route preserves auth and repair handoff semantics", async () => {
  const route = await readFile(START_ROUTE_FILE, "utf8");

  assert.match(route, START_ROUTE_AUTH_RE);
  assert.match(route, START_ROUTE_ORIGIN_RE);
  assert.match(route, START_ROUTE_CONNECTION_FIELD_RE);
  assert.match(route, START_ROUTE_DISPLAY_NAME_FIELD_RE);
  assert.match(route, START_ROUTE_OPTIONAL_CREDENTIAL_RE);
  assert.match(route, START_ROUTE_CREDENTIAL_CAPTURE_RE);
  assert.match(route, START_ROUTE_SAFE_CONTEXT_RE);
  assert.doesNotMatch(route, START_ROUTE_NO_SECRET_LOG_RE);
  assert.doesNotMatch(route, START_ROUTE_NO_SECRET_QUERY_RE);
  assert.match(route, START_ROUTE_SUPPORTED_BROWSER_RE);
  assert.match(route, START_ROUTE_CREATE_SHELL_RE);
  assert.match(route, START_ROUTE_DRAFT_ONE_RE);
  assert.match(route, START_ROUTE_UNSUPPORTED_REDIRECT_RE);
  assert.match(route, START_ROUTE_LAUNCH_REDIRECT_RE);
  assert.doesNotMatch(route, START_ROUTE_FORBIDS_SLOW_RUN_RE);
  assert.match(route, START_ROUTE_ORIGIN_HELPER_IMPORT_RE);
  assert.match(route, START_ROUTE_REDIRECT_HELPER_RE);
});

test("browser-session launch page owns slow run-start and renders inline failure", async () => {
  const panel = await readFile(LAUNCH_PANEL_FILE, "utf8");
  const route = await readFile(LAUNCH_START_ROUTE_FILE, "utf8");

  assert.match(panel, LAUNCH_PANEL_FETCH_RE);
  assert.match(panel, LAUNCH_PANEL_INLINE_FAILURE_RE);
  assert.match(panel, LAUNCH_PANEL_RUNS_FALLBACK_RE);
  assert.match(route, START_ROUTE_AUTH_RE);
  assert.match(route, START_ROUTE_ORIGIN_RE);
  assert.match(route, LAUNCH_START_ROUTE_RUN_RE);
  assert.match(route, LAUNCH_START_ROUTE_ENROLLMENT_ADMISSION_RE);
  assert.match(route, LAUNCH_START_ROUTE_CLEANUP_RE);
  assert.match(route, LAUNCH_START_ROUTE_JSON_RE);
});

test("browser-session launch recovers an already-started run after transport loss", async () => {
  const panel = await readFile(LAUNCH_PANEL_FILE, "utf8");
  const route = await readFile(LAUNCH_RECOVER_ROUTE_FILE, "utf8");

  assert.match(panel, LAUNCH_PANEL_RECOVER_RE);
  assert.match(panel, LAUNCH_PANEL_LOST_TRANSPORT_RECOVERY_RE);
  assert.match(route, LAUNCH_RECOVER_ROUTE_LIST_RE);
  assert.match(route, LAUNCH_RECOVER_ROUTE_CONNECTION_MATCH_RE);
  assert.match(route, LAUNCH_RECOVER_ROUTE_STREAM_HREF_RE);
});
