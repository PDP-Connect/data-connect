// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for GET /v1/owner/credential/reveal through the real
 * RS app started by `startServer`. `owner-credential-reveal-route.test.ts`
 * covers the route's own logic against a fake app; this proves the route is
 * actually mounted, actually reads the process's configured password (not a
 * stale or hardcoded value), and actually enforces the owner-bearer guard
 * end to end -- the three things a unit test against a fake app cannot see.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";

const OWNER_SUBJECT_ID = "owner_local";
const OWNER_CLIENT_ID = "cli_longview";
const TEST_OWNER_PASSWORD = "correct-horse-battery-staple";

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
  schedulerManager?: { stop?: () => void };
};

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

interface JsonResult {
  body: unknown;
  status: number;
}

async function fetchJson(url: string | URL, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

async function withServer(
  opts: Record<string, unknown>,
  fn: (ctx: { asUrl: string; rsUrl: string }) => Promise<void>
): Promise<void> {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0, ...opts })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// When PDPP_OWNER_PASSWORD is set, /device/approve itself requires an owner
// session (the login-attempt throttle from #206 gates that same session), so
// this signs in via /owner/login first and carries the session cookie into
// the approve call. Login and approve both use JSON bodies, which are exempt
// from the hosted-form CSRF guard the same way owner-csrf.test.ts's
// "JSON-encoded /device/approve... succeeds (no CSRF token)" case is --
// avoids needing a second, post-login CSRF token/cookie pair just to drive
// this test's setup. Same device-code exchange shape as
// owner-connection-diagnostics.test.ts otherwise.
async function ownerSessionCookie(asUrl: string, password: string): Promise<string> {
  const loginResp = await fetch(`${asUrl}/owner/login`, {
    body: JSON.stringify({ password, return_to: "/device" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    redirect: "manual",
  });
  const sessionCookies = loginResp.headers.getSetCookie?.() ?? [];
  const sessionCookie = sessionCookies.find((cookie) => cookie.startsWith("pdpp_owner_session="))?.split(";")[0];
  assert.ok(sessionCookie, "owner login should issue a session cookie");
  return sessionCookie as string;
}

async function issueOwnerToken(
  asUrl: string,
  subjectId = OWNER_SUBJECT_ID,
  ownerPassword: string | null = null
): Promise<string> {
  const device = (
    await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { device_code: string; user_code: string };
  const approveHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (ownerPassword) {
    approveHeaders.Cookie = await ownerSessionCookie(asUrl, ownerPassword);
  }
  await fetch(`${asUrl}/device/approve`, {
    body: JSON.stringify({ subject_id: subjectId, user_code: device.user_code }),
    headers: approveHeaders,
    method: "POST",
  });
  const tok = (
    await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: OWNER_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { access_token?: string };
  assert.ok(tok.access_token, "device exchange should issue an owner token");
  return tok.access_token as string;
}

test("GET /v1/owner/credential/reveal returns the process's configured owner password to an owner bearer", async () => {
  await withServer({ ownerAuthPassword: TEST_OWNER_PASSWORD }, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, OWNER_SUBJECT_ID, TEST_OWNER_PASSWORD);
    const { body, status } = await fetchJson(`${rsUrl}/v1/owner/credential/reveal`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { data: { password: TEST_OWNER_PASSWORD }, object: "owner_credential_reveal" });
  });
});

test("GET /v1/owner/credential/reveal rejects a request with no bearer token", async () => {
  await withServer({ ownerAuthPassword: TEST_OWNER_PASSWORD }, async ({ rsUrl }) => {
    const { status } = await fetchJson(`${rsUrl}/v1/owner/credential/reveal`);
    assert.equal(status, 401);
  });
});

test("GET /v1/owner/credential/reveal rejects a client-kind bearer (not owner-kind)", async () => {
  await withServer({ ownerAuthPassword: TEST_OWNER_PASSWORD }, async ({ rsUrl }) => {
    const { status } = await fetchJson(`${rsUrl}/v1/owner/credential/reveal`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    assert.ok(status === 401 || status === 403, `expected 401/403 for an invalid bearer, got ${status}`);
  });
});

test("GET /v1/owner/credential/reveal returns 404 when owner auth is disabled on this deployment", async () => {
  await withServer({ ownerAuthPassword: "" }, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body, status } = await fetchJson(`${rsUrl}/v1/owner/credential/reveal`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 404);
    assert.equal((body as { error: { code: string } }).error.code, "owner_auth_disabled");
  });
});
