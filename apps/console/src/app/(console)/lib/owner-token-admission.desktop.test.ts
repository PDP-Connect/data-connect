// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Default unified desktop: the console process holds the same
 * `PDPP_OWNER_PASSWORD` as the reference server.
 *
 * The cookie is opaque, so the console forwards it to the AS for admission
 * even when this process also has `PDPP_OWNER_PASSWORD`.
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
  ownerCookie = await issueSessionCookie(reference.asUrl, OWNER_PASSWORD);
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

test("desktop: admission asks the AS before returning a warm cached bearer", async () => {
  clearOwnerToken();
  const token = await asRequest(ownerCookie, () => getOwnerToken());
  const before = asCalls().length;
  assert.equal(await asRequest(ownerCookie, () => getOwnerToken()), token);
  assert.ok(asCalls().length > before, "warm-cache admission still checks /owner/session");
});

test("desktop: an anonymous request is refused even with a warm cache", async () => {
  await asRequest(ownerCookie, () => getOwnerToken());
  await assert.rejects(asRequest(null, () => getOwnerToken()), isLoginRedirect);
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

test("desktop: unknown and revoked cookies are refused", async () => {
  await asRequest(ownerCookie, () => getOwnerToken());
  await assert.rejects(asRequest("unknown-session-id", () => getOwnerToken()), isLoginRedirect);
  const revocableCookie = await issueSessionCookie(reference.asUrl, OWNER_PASSWORD);
  const logout = await fetch(`${reference.asUrl}/owner/logout`, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: `pdpp_owner_session=${revocableCookie}`,
    },
    method: "POST",
  });
  assert.equal(logout.status, 204);
  await assert.rejects(asRequest(revocableCookie, () => getOwnerToken()), isLoginRedirect);
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
