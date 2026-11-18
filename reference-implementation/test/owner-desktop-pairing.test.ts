// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import {
  createDesktopPairingStore,
  DESKTOP_PAIRING_ALPHABET,
  DESKTOP_PAIRING_MAX_OUTSTANDING,
  DESKTOP_PAIRING_TTL_SECONDS,
} from "../server/owner-desktop-pairing.ts";
import { createOwnerSessionController, createMemoryOwnerSessionStore } from "../server/owner-session.ts";
import { createOwnerPasswordVerifierStore, setOwnerPassword } from "../server/stores/owner-password-verifier-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";

const TEST_PASSWORD = "placeholder-test-password";
const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}$/u;
const CSRF_HIDDEN_FIELD_PATTERN = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/u;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
  schedulerManager?: { stop?: () => void };
  abortStartupBackfill?: (reason: string) => void;
  startupBackfillDone?: Promise<unknown>;
};

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.("test shutdown");
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv: CloseableServer) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      srv.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
  closeDb();
}

async function withServer(
  opts: Record<string, unknown>,
  fn: (ctx: { asUrl: string }) => Promise<void>
): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
    ...opts,
  })) as StartedServer;
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

function setCookieList(resp: Response): string[] {
  if (typeof resp.headers.getSetCookie === "function") return resp.headers.getSetCookie();
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookiePair(setCookies: readonly string[], name: string): string | null {
  for (const header of setCookies) {
    const [first] = header.split(";");
    if (first?.startsWith(`${name}=`)) return first;
  }
  return null;
}

async function login(asUrl: string, password: string): Promise<{ cookie: string | null; status: number }> {
  const page = await fetch(`${asUrl}/owner/login`, { headers: { Accept: "text/html" }, redirect: "manual" });
  const csrfCookie = cookiePair(setCookieList(page), "pdpp_owner_csrf");
  const html = await page.text();
  const csrfField = html.match(CSRF_HIDDEN_FIELD_PATTERN)?.[1] ?? "";
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField, password, return_to: "/consent" }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie ?? "",
    },
    method: "POST",
    redirect: "manual",
  });
  return { cookie: cookiePair(setCookieList(resp), "pdpp_owner_session"), status: resp.status };
}

interface PairingBody {
  code: string;
  expires_at: string;
  expires_in_seconds: number;
  link: string;
  object: string;
  server_origin: string;
}

async function createPairing(asUrl: string, cookie: string): Promise<{ body: PairingBody; status: number }> {
  const resp = await fetch(`${asUrl}/owner/desktop-pairings`, {
    headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
    method: "POST",
  });
  return { body: (await resp.json()) as PairingBody, status: resp.status };
}

interface RedeemResult {
  body: Record<string, unknown>;
  retryAfter: string | null;
  setCookie: string | null;
  status: number;
}

async function redeem(asUrl: string, payload: unknown, contentType = "application/json"): Promise<RedeemResult> {
  const resp = await fetch(`${asUrl}/owner/desktop-pairings/redeem`, {
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    headers: { Accept: "application/json", "Content-Type": contentType },
    method: "POST",
  });
  return {
    body: (await resp.json()) as Record<string, unknown>,
    retryAfter: resp.headers.get("retry-after"),
    setCookie: resp.headers.get("set-cookie"),
    status: resp.status,
  };
}

function sessionStatus(asUrl: string, session: string): Promise<number> {
  return fetch(`${asUrl}/owner/session`, {
    headers: { Accept: "application/json", Cookie: `pdpp_owner_session=${session}` },
  }).then((resp) => resp.status);
}

const INVALID_CODE_ERROR = {
  error: {
    code: "invalid_pairing_code",
    message: "This pairing code is not valid. Create a new one in the server's settings.",
  },
};

// ── store (injected clock) ───────────────────────────────────────────────────

test("desktop pairing store: codes use the 12-character alphabet in dashed groups of four", () => {
  const store = createDesktopPairingStore();
  for (let i = 0; i < 50; i++) {
    const { code } = store.create();
    assert.match(code, CODE_PATTERN);
    for (const ch of code.replaceAll("-", "")) assert.ok(DESKTOP_PAIRING_ALPHABET.includes(ch));
  }
  assert.equal(DESKTOP_PAIRING_ALPHABET.length, 30);
  assert.doesNotMatch(DESKTOP_PAIRING_ALPHABET, /[IOLU01]/u);
});

test("desktop pairing store: a code redeems once, tolerates case, dashes and spaces, then is gone", () => {
  const store = createDesktopPairingStore();
  const { code } = store.create();
  assert.equal(store.redeem(`  ${code.toLowerCase().replaceAll("-", " ")} `), true);
  assert.equal(store.redeem(code), false);
});

test("desktop pairing store: a code expires after ten minutes on the injected clock", () => {
  let now = 1_000_000;
  const store = createDesktopPairingStore({ now: () => now });
  const live = store.create();
  const stale = store.create();
  assert.equal(live.expiresAtMs, now + DESKTOP_PAIRING_TTL_SECONDS * 1000);
  now += (DESKTOP_PAIRING_TTL_SECONDS - 1) * 1000;
  assert.equal(store.redeem(live.code), true, "still valid one second before expiry");
  now += 1000;
  assert.equal(store.redeem(stale.code), false, "expired at the TTL boundary");
});

test("desktop pairing store: the sixth outstanding code evicts the oldest", () => {
  assert.equal(DESKTOP_PAIRING_MAX_OUTSTANDING, 5);
  const store = createDesktopPairingStore();
  const codes = Array.from({ length: 6 }, () => store.create().code);
  assert.equal(store.redeem(codes[0] as string), false, "oldest evicted");
  for (const code of codes.slice(1)) assert.equal(store.redeem(code), true);
});

test("owner session controller: issueSessionToken mints a caller-TTL session and returns the opaque id", async () => {
  const controller = createOwnerSessionController({
    enabled: true,
    sessionStore: createMemoryOwnerSessionStore(),
  });
  const before = Math.floor(Date.now() / 1000);
  const minted = await controller.issueSessionToken({ label: "  Laptop  " }, 3600);
  assert.ok(minted);
  assert.ok(minted.expiresAtSeconds >= before + 3600 && minted.expiresAtSeconds <= before + 3601);
  assert.ok((await controller.readSessionFromCookieValue(minted.sessionId)) !== null);
  const [summary] = await controller.listSessions(controller.subjectId);
  assert.equal(summary?.label, "Laptop");
  const disabled = createOwnerSessionController({ enabled: false, sessionStore: createMemoryOwnerSessionStore() });
  assert.equal(await disabled.issueSessionToken({}, 3600), null);
});

// ── routes ───────────────────────────────────────────────────────────────────

test("desktop pairing: creating a code requires an owner session", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/desktop-pairings`, {
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(resp.status, 401);
    assert.equal(((await resp.json()) as { error: { code: string } }).error.code, "owner_session_required");
  });
});

test("desktop pairing: creating a code enforces CSRF where the sibling session routes do", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    assert.ok(cookie);
    const forged = await fetch(`${asUrl}/owner/desktop-pairings`, {
      body: "x=1",
      headers: { Accept: "application/json", "Content-Type": "text/plain", Cookie: cookie },
      method: "POST",
    });
    assert.equal(forged.status, 403);
    assert.equal(((await forged.json()) as { error: { code: string } }).error.code, "csrf_token_invalid");
    const json = await createPairing(asUrl, cookie);
    assert.equal(json.status, 201, "a JSON caller needs no CSRF token, as for /owner/sessions/revoke-others");
  });
});

test("desktop pairing: create returns the contract body with the public origin and a valid code", async () => {
  await withServer(
    { asPublicUrl: "https://vault.example.com", ownerAuthPassword: TEST_PASSWORD },
    async ({ asUrl }) => {
      const { cookie } = await login(asUrl, TEST_PASSWORD);
      assert.ok(cookie);
      const before = Date.now();
      const { body, status } = await createPairing(asUrl, cookie);
      assert.equal(status, 201);
      assert.equal(body.object, "desktop_pairing");
      assert.match(body.code, CODE_PATTERN);
      assert.equal(body.expires_in_seconds, 600);
      const expires = Date.parse(body.expires_at);
      assert.ok(expires >= before + 599_000 && expires <= Date.now() + 600_000);
      assert.equal(body.server_origin, "https://vault.example.com");
      assert.equal(
        body.link,
        `vana://attach?server=${encodeURIComponent(body.server_origin)}&code=${body.code}`
      );
    }
  );
});

test("desktop pairing: without a configured public URL the origin follows the request, as OAuth metadata does", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    assert.ok(cookie);
    const { body } = await createPairing(asUrl, cookie);
    const metadata = (await (await fetch(`${asUrl}/.well-known/oauth-authorization-server`)).json()) as {
      issuer: string;
    };
    assert.equal(body.server_origin, new URL(metadata.issuer).origin);
    assert.equal(body.server_origin, new URL(asUrl).origin);
  });
});

test("desktop pairing: redeem mints an owner session the server accepts, listed with its label", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    assert.ok(cookie);
    const { body: pairing } = await createPairing(asUrl, cookie);
    const redeemed = await redeem(asUrl, { code: pairing.code, label: "  Tim's laptop  " });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.setCookie, null, "the session id travels in the body only");
    assert.equal(redeemed.body.object, "desktop_pairing_session");
    assert.equal(redeemed.body.expires_in_seconds, THIRTY_DAYS_SECONDS);
    assert.equal(redeemed.body.label, "Tim's laptop");
    const session = redeemed.body.session as string;
    assert.match(session, /^[A-Za-z0-9_-]{43}$/u);
    const expiresMs = Date.parse(redeemed.body.expires_at as string);
    assert.ok(Math.abs(expiresMs - (Date.now() + THIRTY_DAYS_SECONDS * 1000)) < 10_000, "30 day expiry");

    assert.equal(await sessionStatus(asUrl, session), 204);

    const list = (await (
      await fetch(`${asUrl}/owner/sessions`, { headers: { Accept: "application/json", Cookie: cookie } })
    ).json()) as { sessions: Array<{ id: string; label: string; current: boolean }> };
    const paired = list.sessions.find((entry) => entry.label === "Tim's laptop");
    assert.ok(paired, "the paired desktop appears in the session list");
    assert.equal(paired.current, false);
    assert.doesNotMatch(JSON.stringify(list), new RegExp(session, "u"), "the list never carries the session id");
  });
});

test("desktop pairing: the label defaults and is clamped to 80 characters", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    assert.ok(cookie);
    const first = await redeem(asUrl, { code: (await createPairing(asUrl, cookie)).body.code });
    assert.equal(first.body.label, "DataConnect desktop");
    const blank = await redeem(asUrl, { code: (await createPairing(asUrl, cookie)).body.code, label: "   " });
    assert.equal(blank.body.label, "DataConnect desktop");
    const long = await redeem(asUrl, {
      code: (await createPairing(asUrl, cookie)).body.code,
      label: "x".repeat(200),
    });
    assert.equal((long.body.label as string).length, 80);
  });
});

test("desktop pairing: a code is single use and normalizes case and dashes", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    assert.ok(cookie);
    const { body: pairing } = await createPairing(asUrl, cookie);
    const sloppy = ` ${pairing.code.toLowerCase().replaceAll("-", "")} `;
    assert.equal((await redeem(asUrl, { code: sloppy })).status, 200);
    const second = await redeem(asUrl, { code: pairing.code });
    assert.equal(second.status, 401);
    assert.deepEqual(second.body, INVALID_CODE_ERROR);
  });
});

test("desktop pairing: unknown, used and expired codes return one identical 401", async (t) => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    assert.ok(cookie);
    const used = (await createPairing(asUrl, cookie)).body.code;
    assert.equal((await redeem(asUrl, { code: used })).status, 200);
    const expiring = (await createPairing(asUrl, cookie)).body.code;

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + (DESKTOP_PAIRING_TTL_SECONDS + 1) * 1000 });
    const unknown = await redeem(asUrl, { code: "ABCD-EFGH-JKMN" });
    const reused = await redeem(asUrl, { code: used });
    const expired = await redeem(asUrl, { code: expiring });
    t.mock.timers.reset();
    for (const result of [unknown, reused, expired]) {
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, INVALID_CODE_ERROR);
    }
  });
});

test("desktop pairing: redeem rejects a malformed body with 400 invalid_request", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    for (const payload of [{}, { code: 42 }, { code: "" }, { code: "ABCD", label: 7 }, [], "null"]) {
      const result = await redeem(asUrl, payload);
      assert.equal(result.status, 400, JSON.stringify(payload));
      assert.equal((result.body.error as { code: string }).code, "invalid_request");
    }
  });
});

test("desktop pairing: bad codes are throttled with a JSON 429 and Retry-After; a good code clears it", async () => {
  await withServer(
    {
      ownerAuthLoginRateLimit: { max: 3, maxLocal: 3, windowMs: 60_000 },
      ownerAuthPassword: TEST_PASSWORD,
    },
    async ({ asUrl }) => {
      const { cookie } = await login(asUrl, TEST_PASSWORD);
      assert.ok(cookie);
      const { body: pairing } = await createPairing(asUrl, cookie);
      assert.equal((await redeem(asUrl, { code: "AAAA-AAAA-AAAA" })).status, 401);
      assert.equal((await redeem(asUrl, { code: pairing.code })).status, 200, "the right code still works");
      for (let i = 0; i < 3; i++) assert.equal((await redeem(asUrl, { code: "AAAA-AAAA-AAAA" })).status, 401);
      const throttled = await redeem(asUrl, { code: "AAAA-AAAA-AAAA" });
      assert.equal(throttled.status, 429);
      assert.ok(Number(throttled.retryAfter) > 0);
      assert.equal((throttled.body.error as { code: string }).code, "owner_login_rate_limited");
    }
  );
});

test("desktop pairing: redeem is unavailable when owner auth is disabled", async () => {
  await withServer({}, async ({ asUrl }) => {
    const result = await redeem(asUrl, { code: "ABCD-EFGH-JKMN" });
    assert.equal(result.status, 404);
    assert.equal((result.body.error as { code: string }).code, "owner_auth_disabled");
  });
});

test("desktop pairing: on a hosted server server_origin is PDPP_REFERENCE_ORIGIN, not the request Host", async () => {
  await withServer(
    {
      ownerAuthPassword: TEST_PASSWORD,
      referenceOrigin: "https://vault.example.com",
      trustedMetadataHosts: "localhost",
    },
    async ({ asUrl }) => {
      const { cookie } = await login(asUrl, TEST_PASSWORD);
      assert.ok(cookie);
      const { body, status } = await createPairing(asUrl, cookie);
      assert.equal(status, 201);
      assert.equal(body.server_origin, "https://vault.example.com");
      assert.ok(body.link.startsWith("vana://attach?server=https%3A%2F%2Fvault.example.com&code="));
    }
  );
});

test("desktop pairing: revoking the paired session ends it immediately", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    assert.ok(cookie);
    const redeemed = await redeem(asUrl, { code: (await createPairing(asUrl, cookie)).body.code, label: "Desk" });
    const session = redeemed.body.session as string;
    assert.equal(await sessionStatus(asUrl, session), 204);
    const list = (await (
      await fetch(`${asUrl}/owner/sessions`, { headers: { Accept: "application/json", Cookie: cookie } })
    ).json()) as { sessions: Array<{ id: string; label: string }> };
    const publicId = list.sessions.find((entry) => entry.label === "Desk")?.id;
    assert.ok(publicId);
    const revoke = await fetch(`${asUrl}/owner/sessions/${publicId}/revoke`, {
      headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
      method: "POST",
    });
    assert.equal(revoke.status, 204);
    assert.equal(await sessionStatus(asUrl, session), 401);
  });
});

test("desktop pairing: an owner password change revokes the paired session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdpp-desktop-pairing-"));
  const dbPath = join(directory, "owner.sqlite");
  const oldPassword = "correct-horse-battery-staple";
  const newPassword = "a-new-password-with-fifteen-plus";
  try {
    initDb(dbPath);
    await setOwnerPassword(createOwnerPasswordVerifierStore(), oldPassword);
    closeDb();
    await withServer({ dbPath }, async ({ asUrl }) => {
      const { cookie } = await login(asUrl, oldPassword);
      assert.ok(cookie);
      const redeemed = await redeem(asUrl, { code: (await createPairing(asUrl, cookie)).body.code });
      const session = redeemed.body.session as string;
      assert.equal(await sessionStatus(asUrl, session), 204);
      const change = await fetch(`${asUrl}/owner/password/change`, {
        body: JSON.stringify({ currentPassword: oldPassword, newPassword }),
        headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
        method: "POST",
      });
      assert.equal(change.status, 204);
      assert.equal(await sessionStatus(asUrl, session), 401);
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
