// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Default unified desktop: the console process holds the same
 * `PDPP_OWNER_PASSWORD` as the reference server.
 *
 * Here the console validates the session cookie itself (local HMAC), and
 * `verifyDashboardSession()` already refuses anonymous requests before any
 * dashboard client asks for the bearer. This topology was NOT open to the
 * split-deployment bypass. These tests pin that `getOwnerToken()` keeps using
 * the local check (no extra AS round trip) and that it now refuses an
 * anonymous request on its own, without relying on the caller's gate.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  asRequest,
  installNextRequestMocks,
  isLoginRedirect,
  issueSessionCookie,
  OWNER_PASSWORD,
  recordFetches,
  startReference,
} from "./owner-token-admission.harness.ts";

type OwnerTokenModule = typeof import("./owner-token.ts");
type SettingsActions = typeof import("../settings/desktop-settings-actions.ts");

let reference: Awaited<ReturnType<typeof startReference>>;
let fetches: ReturnType<typeof recordFetches>;
let ownerCookie: string;
let clearOwnerToken: OwnerTokenModule["clearOwnerToken"];
let getOwnerToken: OwnerTokenModule["getOwnerToken"];
let isOwnerSessionGateEnabled: OwnerTokenModule["isOwnerSessionGateEnabled"];
let loadAppConfigAction: SettingsActions["loadAppConfigAction"];
let saveAppConfigAction: SettingsActions["saveAppConfigAction"];

test.before(async () => {
  installNextRequestMocks(test);
  process.env.PDPP_OWNER_PASSWORD = OWNER_PASSWORD;
  reference = await startReference({ ownerAuthPassword: OWNER_PASSWORD });
  ({ clearOwnerToken, getOwnerToken, isOwnerSessionGateEnabled } = await import("./owner-token.ts"));
  ({ loadAppConfigAction, saveAppConfigAction } = await import("../settings/desktop-settings-actions.ts"));
  ownerCookie = await issueSessionCookie(OWNER_PASSWORD);
  fetches = recordFetches();
});

test.after(async () => {
  fetches.restore();
  delete process.env.PDPP_OWNER_PASSWORD;
  await reference.stop();
});

function asCalls(): string[] {
  return fetches.calls.filter((url) => url.startsWith(reference.asUrl));
}

test("desktop topology: the console holds the password, so its local gate is on", () => {
  assert.equal(isOwnerSessionGateEnabled(), true);
});

test("desktop: admission is local — a warm-cache owner request makes no AS call", async () => {
  clearOwnerToken();
  const token = await asRequest(ownerCookie, () => getOwnerToken());
  const before = asCalls().length;
  assert.equal(await asRequest(ownerCookie, () => getOwnerToken()), token);
  assert.equal(asCalls().length, before);
});

test("desktop: an anonymous request is refused locally, without an AS call, even with a warm cache", async () => {
  await asRequest(ownerCookie, () => getOwnerToken());
  const before = asCalls().length;
  await assert.rejects(asRequest(null, () => getOwnerToken()), isLoginRedirect);
  assert.equal(asCalls().length, before);
});

test("desktop: an anonymous request cannot join an in-flight owner mint", async () => {
  clearOwnerToken();
  const owner = asRequest(ownerCookie, () => getOwnerToken());
  const anonymous = asRequest(null, () => getOwnerToken());
  const [ownerResult, anonymousResult] = await Promise.allSettled([owner, anonymous]);
  assert.equal(ownerResult.status, "fulfilled");
  assert.equal(anonymousResult.status, "rejected");
  assert.ok(isLoginRedirect((anonymousResult as PromiseRejectedResult).reason));
});

test("desktop: expired and wrong-password cookies are refused locally", async () => {
  await asRequest(ownerCookie, () => getOwnerToken());
  const expired = await issueSessionCookie(OWNER_PASSWORD, { expired: true });
  await assert.rejects(asRequest(expired, () => getOwnerToken()), isLoginRedirect);
  const otherPassword = await issueSessionCookie("the-password-before-rotation");
  await assert.rejects(asRequest(otherPassword, () => getOwnerToken()), isLoginRedirect);
});

test("desktop: owner read and mutation through the Server Actions; anonymous calls are refused", async () => {
  const initial = await asRequest(ownerCookie, () => loadAppConfigAction());
  const saved = await asRequest(ownerCookie, () =>
    saveAppConfigAction({ ...initial, startMinimized: !initial.startMinimized })
  );
  assert.ok(saved.ok, saved.ok ? "" : saved.message);

  await assert.rejects(asRequest(null, () => loadAppConfigAction()), isLoginRedirect);
  await assert.rejects(
    asRequest(null, () => saveAppConfigAction({ ...initial, closeToTray: !initial.closeToTray })),
    isLoginRedirect
  );
  const after = await asRequest(ownerCookie, () => loadAppConfigAction());
  assert.equal(after.closeToTray, initial.closeToTray);
  assert.equal(after.startMinimized, !initial.startMinimized);
});
