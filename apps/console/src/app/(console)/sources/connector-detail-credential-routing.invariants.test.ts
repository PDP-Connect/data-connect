// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DETAIL_PAGE = `${HERE}[connector]/source-page.tsx`;

const STATIC_SECRET_CAPTURE_RESOLVED_ONCE =
  /const staticSecretCapture = staticSecretCredentialCaptureFromManifest\(manifest\)/;
// Binding-first: the connection's browser-session binding is resolved and
// checked BEFORE the connector-level static-secret capability. A browser-session
// connection reconnects its session; only a NON-session connection routes to
// static-secret capture (even when the connector supports a static secret).
const SESSION_BOUND_RESOLVED = /const sessionBound = isBrowserSessionBoundConnection\(sourceBindingKind\)/;
// The stored-credential and browser-session repair hrefs are resolved up front,
// and the compatibility `credentialUpdateHref` fallback prefers the session
// reconnect for a session-bound connection before static-secret capture.
const STORED_CREDENTIAL_HREF_RESOLVED =
  /const storedCredentialUpdateHref =\s*staticSecretCapture === null \? null : updateCredentialHref\(connectorId, repairConnectionId\)/;
const BROWSER_SESSION_HREF_RESOLVED =
  /const browserSessionRepairHref =\s*sessionBound \|\| manifestBrowserBound\s*\? browserSessionReconnectHref\(connectorId, repairConnectionId\)/;
const SESSION_BOUND_PRECEDES_STATIC_SECRET =
  /if \(sessionBound\) \{[\s\S]{0,120}return browserSessionRepairHref;[\s\S]{0,120}if \(storedCredentialUpdateHref !== null\) \{/;
// The static-secret update affordance is suppressed for a session-bound
// connection AND whenever the rendered action's own surface says the repair is
// stored-credential capture (so the server-owned surface, not a second guess,
// drives the button). A browser-session connection never offers a
// credential-capture button as its repair.
const STATIC_SECRET_UPDATE_CAPABILITY_GATED_ON_BINDING_AND_SURFACE =
  /hasStaticSecretCredentialUpdate=\{\s*credentialUpdateHref !== null && primaryActionSurface !== "stored_credential" && primaryActionSurface !== "browser_session"\s*\}/;
const STATIC_SECRET_UPDATE_LINK_VISIBLE = /storedCredentialUpdateHref && !revoked && hasStaticSecretCredentialUpdate/;
// The rendered `reauth` action routes by the server-owned owner-action surface,
// not by connector-manifest capability alone.
const PRIMARY_ACTION_SURFACE_READ = /const primaryActionSurface = connectionPrimaryAction\?\.surface\?\.kind \?\? null/;
const REAUTH_ROUTES_BY_SURFACE = /switch \(action\.surface\?\.kind\) \{/;
const REAUTH_STORED_CREDENTIAL_ROUTE =
  /case "stored_credential":[\s\S]{0,160}href: storedCredentialUpdateHref \?\? fallbackHref/;
const REAUTH_BROWSER_SESSION_ROUTE =
  /case "browser_session":[\s\S]{0,160}href: browserSessionRepairHref \?\? fallbackHref/;
// Static-secret repair copy says "Update credential", not a generic reconnect.
const STORED_CREDENTIAL_COPY_IS_UPDATE = /label: "Update credential"/;
// Compatibility: older payloads without a surface still route through the
// legacy credentialUpdateHref fallback.
const REAUTH_FALLBACK_FOR_OLD_PAYLOADS =
  /const fallbackHref = credentialUpdateHref \?\? addSourceHrefForConnector\(connectorId\)/;

test("detail-page repair routing is connection-binding-first (session repair before static-secret capture)", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, STATIC_SECRET_CAPTURE_RESOLVED_ONCE);
  assert.match(src, SESSION_BOUND_RESOLVED);
  assert.match(src, STORED_CREDENTIAL_HREF_RESOLVED);
  assert.match(src, BROWSER_SESSION_HREF_RESOLVED);
  assert.match(src, SESSION_BOUND_PRECEDES_STATIC_SECRET);
  assert.match(src, STATIC_SECRET_UPDATE_CAPABILITY_GATED_ON_BINDING_AND_SURFACE);
  assert.match(src, STATIC_SECRET_UPDATE_LINK_VISIBLE);
});

// A recovered historical-archive row (paused, never revoked) is repaired by
// updating its sign-in, not by a bare resume: a recovered row typically has no
// surviving credential, so resuming without one would just fail on the next
// run (the server resumes a paused archive when it saves the sign-in). The
// decision now lives in the one status-words file; the page renders the action
// kind it is given. A bare resume is chosen for an archive only when the page
// knows there is no sign-in to update (`signInRepairAvailable === false`).
const STATUS_WORDS = `${HERE}../lib/source-status-words.ts`;
const PAUSED_GATE = /const paused = !revoked && overview\.connectionStatus === "paused"/;
const PAUSED_ARCHIVE_REPAIRS_SIGN_IN_FIRST =
  /source\.source_binding_kind === "historical_archive"\s*\?\s*signInRepairAvailable === false\s*\?\s*action\("resume", [^)]*\)\s*:\s*action\("repair_credential", [^)]*\)\s*:\s*action\("resume", /;
const REPAIR_CREDENTIAL_ACTION_LINKS_TO_REPAIR =
  /statusAction\?\.kind === "repair_credential" && credentialUpdateHref\) \{\s*return <Link [^>]*href=\{credentialUpdateHref\}/;
// Every OTHER paused row - notably one the owner paused deliberately - gets a
// real Resume action that posts to its owner-session server action, and an
// actively-collecting row gets Pause, so the pause/resume cycle is closed.
const RESUME_ACTION_POSTS_RESUME = /statusAction\?\.kind === "resume"\) \{\s*return <ResumeConnectionButton/;
const PAUSABLE_GATE = /const pausable = !\(revoked \|\| paused\) && overview\.connectionStatus === "active"/;
const PAUSE_CONNECTION_SECTION_POSTS_PAUSE =
  /function PauseConnectionSection\([\s\S]{0,600}<form action=\{pauseConnectionAction\}>/;

test("detail-page rendered reauth routes and labels by the server-owned action surface", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, PRIMARY_ACTION_SURFACE_READ);
  assert.match(src, REAUTH_ROUTES_BY_SURFACE);
  assert.match(src, REAUTH_STORED_CREDENTIAL_ROUTE);
  assert.match(src, REAUTH_BROWSER_SESSION_ROUTE);
  assert.match(src, STORED_CREDENTIAL_COPY_IS_UPDATE);
  assert.match(src, REAUTH_FALLBACK_FOR_OLD_PAYLOADS);
});

test("a recovered historical-archive row repairs its sign-in before any bare resume", async () => {
  const page = await readFile(DETAIL_PAGE, "utf8");
  const words = await readFile(STATUS_WORDS, "utf8");
  assert.match(page, PAUSED_GATE);
  assert.match(words, PAUSED_ARCHIVE_REPAIRS_SIGN_IN_FIRST);
  assert.match(page, REPAIR_CREDENTIAL_ACTION_LINKS_TO_REPAIR);
});

test("a non-archive paused row surfaces a real resume action, and an active row a pause action", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, RESUME_ACTION_POSTS_RESUME);
  assert.match(src, PAUSABLE_GATE);
  assert.match(src, PAUSE_CONNECTION_SECTION_POSTS_PAUSE);
});
