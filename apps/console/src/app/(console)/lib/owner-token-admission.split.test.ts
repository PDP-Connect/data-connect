// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Split deployment: only the authorization server holds
 * `PDPP_OWNER_PASSWORD`; the console process does not.
 *
 * In this topology the console must still ask the AS to judge the forwarded
 * cookie because it does not hold the password. The owner bearer that
 * `getOwnerToken()` returns goes straight to the RS, which checks only the
 * bearer. So `getOwnerToken()` must establish that the CURRENT request is the
 * owner's before it hands out a cached or in-flight bearer. The process-wide
 * cache holds the owner's bearer; it is not evidence about the request.
 *
 * Real console modules, real reference AS/RS; see the harness for what is
 * substituted.
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
type VerifyModule = typeof import("./verify-session.ts");

let reference: Awaited<ReturnType<typeof startReference>>;
let fetches: ReturnType<typeof recordFetches>;
let ownerCookie: string;
let clearOwnerToken: OwnerTokenModule["clearOwnerToken"];
let getOwnerToken: OwnerTokenModule["getOwnerToken"];
let isOwnerSessionGateEnabled: OwnerTokenModule["isOwnerSessionGateEnabled"];
let loadAppConfigAction: SettingsActions["loadAppConfigAction"];
let saveAppConfigAction: SettingsActions["saveAppConfigAction"];
let verifyDashboardSession: VerifyModule["verifyDashboardSession"];

test.before(async () => {
  installNextRequestMocks(test);
  delete process.env.PDPP_OWNER_PASSWORD;
  reference = await startReference({ ownerAuthPassword: OWNER_PASSWORD });
  ({ clearOwnerToken, getOwnerToken, isOwnerSessionGateEnabled } = await import("./owner-token.ts"));
  ({ verifyDashboardSession } = await import("./verify-session.ts"));
  ({ loadAppConfigAction, saveAppConfigAction } = await import("../settings/desktop-settings-actions.ts"));
  ownerCookie = await issueSessionCookie(reference.asUrl, OWNER_PASSWORD);
  fetches = recordFetches();
});

test.after(async () => {
  fetches.restore();
  await reference.stop();
});

function asCalls(): string[] {
  return fetches.calls.filter((url) => url.startsWith(reference.asUrl));
}

function mintCalls(): string[] {
  return asCalls().filter((url) => url.includes("/oauth/") || url.includes("/device/"));
}

async function warmCache(): Promise<string> {
  clearOwnerToken();
  return asRequest(ownerCookie, () => getOwnerToken());
}

test("split topology: the console holds no password, so its local gate is off", () => {
  assert.equal(isOwnerSessionGateEnabled(), false);
});

test("split: the DAL checks the AS even when the console has no password", async () => {
  await assert.rejects(asRequest(null, () => verifyDashboardSession()), isLoginRedirect);
  assert.ok(asCalls().some((url) => url === `${reference.asUrl}/owner/session`));
  await asRequest(ownerCookie, () => verifyDashboardSession());
});

test("split: AS session-check failures do not redirect to sign-in or release a cached bearer", async () => {
  await warmCache();
  const originalFetch = globalThis.fetch;
  const mintsBefore = mintCalls().length;
  try {
    for (const status of [503, 404]) {
      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return url === `${reference.asUrl}/owner/session`
          ? Promise.resolve(new Response("AS unavailable", { status }))
          : originalFetch(input, init);
      };
      await assert.rejects(
        asRequest(ownerCookie, () => verifyDashboardSession()),
        new RegExp(`owner session check failed \\(${status}\\)`)
      );
      await assert.rejects(
        asRequest(ownerCookie, () => getOwnerToken()),
        new RegExp(`owner session check failed \\(${status}\\)`)
      );
    }
    assert.equal(mintCalls().length, mintsBefore, "a failed AS check must not start a bearer mint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("split: authenticated request, then anonymous request — the cached bearer is not handed out", async () => {
  const token = await warmCache();
  assert.ok(token.length > 0);

  const mintsBefore = mintCalls().length;
  await assert.rejects(asRequest(null, () => getOwnerToken()), isLoginRedirect);
  assert.equal(mintCalls().length, mintsBefore, "the anonymous request must not start a mint either");

  // The owner keeps working from the warm cache: no new mint.
  assert.equal(await asRequest(ownerCookie, () => getOwnerToken()), token);
  assert.equal(mintCalls().length, mintsBefore);
});

test("split: force=true does not skip admission", async () => {
  await warmCache();
  const mintsBefore = mintCalls().length;
  await assert.rejects(asRequest(null, () => getOwnerToken(true)), isLoginRedirect);
  assert.equal(mintCalls().length, mintsBefore);
});

test("split: anonymous request, then authenticated request — the owner is not blocked", async () => {
  clearOwnerToken();
  await assert.rejects(asRequest(null, () => getOwnerToken()), isLoginRedirect);
  const token = await asRequest(ownerCookie, () => getOwnerToken());
  assert.ok(token.length > 0);
});

test("split: an anonymous request cannot join an authenticated mint that is in flight", async () => {
  clearOwnerToken();
  const deviceAuthorizationCalls = () => asCalls().filter((url) => url.endsWith("/oauth/device_authorization")).length;
  const before = deviceAuthorizationCalls();

  const owner = asRequest(ownerCookie, () => getOwnerToken());
  // Wait until the owner's mint is really on the wire before the anonymous
  // request arrives, so it would find the shared in-flight promise.
  while (deviceAuthorizationCalls() === before) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const anonymous = asRequest(null, () => getOwnerToken());

  const [ownerResult, anonymousResult] = await Promise.allSettled([owner, anonymous]);
  assert.equal(ownerResult.status, "fulfilled");
  assert.equal(anonymousResult.status, "rejected");
  assert.ok(isLoginRedirect((anonymousResult as PromiseRejectedResult).reason));
});

test("split: concurrent anonymous and authenticated requests on a cold cache", async () => {
  clearOwnerToken();
  const [anonymousResult, ownerResult] = await Promise.allSettled([
    asRequest(null, () => getOwnerToken()),
    asRequest(ownerCookie, () => getOwnerToken()),
  ]);
  assert.equal(anonymousResult.status, "rejected");
  assert.ok(isLoginRedirect((anonymousResult as PromiseRejectedResult).reason));
  assert.equal(ownerResult.status, "fulfilled");
});

test("split: an unknown session cookie is refused even with a warm cache", async () => {
  await warmCache();
  await assert.rejects(asRequest("unknown-session-id", () => getOwnerToken()), isLoginRedirect);
});

test("split: after logout the browser has no session, and the warm cache does not stand in for one", async () => {
  await warmCache();
  const logoutCookie = await issueSessionCookie(reference.asUrl, OWNER_PASSWORD);
  const logout = await fetch(`${reference.asUrl}/owner/logout`, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: `pdpp_owner_session=${logoutCookie}`,
    },
    method: "POST",
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
  await assert.rejects(asRequest(null, () => getOwnerToken()), isLoginRedirect);
});

test("split: a session revoked by logout is refused", async () => {
  await warmCache();
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

test("split: owner read and mutation through the Server Actions reach the real RS only for the owner", async () => {
  await warmCache();

  const initial = await asRequest(ownerCookie, () => loadAppConfigAction());
  assert.equal(typeof initial.startMinimized, "boolean");

  const saved = await asRequest(ownerCookie, () =>
    saveAppConfigAction({ ...initial, startMinimized: !initial.startMinimized })
  );
  assert.ok(saved.ok, saved.ok ? "" : saved.message);
  assert.equal(saved.config.startMinimized, !initial.startMinimized);

  // Anonymous read: redirected to login, no config returned.
  await assert.rejects(asRequest(null, () => loadAppConfigAction()), isLoginRedirect);

  // Anonymous mutation: refused, and the stored config is unchanged.
  const rsWritesBefore = fetches.calls.filter((url) => url.startsWith(reference.rsUrl)).length;
  await assert.rejects(
    asRequest(null, () => saveAppConfigAction({ ...initial, closeToTray: !initial.closeToTray })),
    isLoginRedirect
  );
  assert.equal(
    fetches.calls.filter((url) => url.startsWith(reference.rsUrl)).length,
    rsWritesBefore,
    "the anonymous request must never reach the RS"
  );
  const after = await asRequest(ownerCookie, () => loadAppConfigAction());
  assert.equal(after.closeToTray, initial.closeToTray);
  assert.equal(after.startMinimized, !initial.startMinimized);
});
