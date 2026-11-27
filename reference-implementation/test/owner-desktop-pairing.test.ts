// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createInstanceIdentityProvider, instanceFingerprint, instanceProofMessage } from "../server/instance-identity.ts";
import { createOwnerAuthPlaceholder } from "../server/owner-auth.ts";
import {
  createDesktopPairingStore,
  DESKTOP_PAIRING_ALPHABET,
  DESKTOP_PAIRING_MAX_OUTSTANDING,
  DESKTOP_PAIRING_TTL_SECONDS,
} from "../server/owner-desktop-pairing.ts";
import {
  createMemoryOwnerSessionStore,
  createOwnerSessionController,
  type OwnerSessionRecord,
  type OwnerSessionStore,
} from "../server/owner-session.ts";
import { createOwnerPasswordVerifierStore, setOwnerPassword } from "../server/stores/owner-password-verifier-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";

// The instance identity file lives under PDPP_DATA_DIR; keep it out of the working tree.
const IDENTITY_DATA_DIR = mkdtempSync(join(tmpdir(), "pdpp-desktop-pairing-identity-"));
process.env.PDPP_DATA_DIR = IDENTITY_DATA_DIR;
after(() => rm(IDENTITY_DATA_DIR, { force: true, recursive: true }));

const TEST_PASSWORD = "placeholder-test-password";
const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}$/u;
const CSRF_HIDDEN_FIELD_PATTERN = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/u;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

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
  }));
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeTestServer(server);
    closeDb();
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
  server_fingerprint: string;
  server_origin: string;
  server_public_key: string;
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
    const { code } = store.create("issuer-1");
    assert.match(code, CODE_PATTERN);
    for (const ch of code.replaceAll("-", "")) assert.ok(DESKTOP_PAIRING_ALPHABET.includes(ch));
  }
  assert.equal(DESKTOP_PAIRING_ALPHABET.length, 30);
  assert.doesNotMatch(DESKTOP_PAIRING_ALPHABET, /[IOLU01]/u);
});

test("desktop pairing store: a code redeems once, tolerates case, dashes and spaces, then is gone", () => {
  const store = createDesktopPairingStore();
  const { code } = store.create("issuer-1");
  assert.equal(store.redeem(`  ${code.toLowerCase().replaceAll("-", " ")} `), "issuer-1", "redeem returns the issuer");
  assert.equal(store.redeem(code), null);
});

test("desktop pairing store: a code expires after ten minutes on the injected clock", () => {
  let now = 1_000_000;
  const store = createDesktopPairingStore({ now: () => now });
  const live = store.create("issuer-1");
  const stale = store.create("issuer-1");
  assert.equal(live.expiresAtMs, now + DESKTOP_PAIRING_TTL_SECONDS * 1000);
  now += (DESKTOP_PAIRING_TTL_SECONDS - 1) * 1000;
  assert.equal(store.redeem(live.code), "issuer-1", "still valid one second before expiry");
  now += 1000;
  assert.equal(store.redeem(stale.code), null, "expired at the TTL boundary");
});

test("desktop pairing store: the sixth outstanding code evicts the oldest", () => {
  assert.equal(DESKTOP_PAIRING_MAX_OUTSTANDING, 5);
  const store = createDesktopPairingStore();
  const codes = Array.from({ length: 6 }, () => store.create("issuer-1").code);
  assert.equal(store.redeem(codes[0] as string), null, "oldest evicted");
  for (const code of codes.slice(1)) assert.equal(store.redeem(code), "issuer-1");
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
      assert.equal(body.link, `https://vault.example.com/settings#code=${body.code}&key=${body.server_public_key}`);
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
    const redeemed = await redeem(asUrl, { code: pairing.code, label: "  Example laptop  " });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.setCookie, null, "the session id travels in the body only");
    assert.equal(redeemed.body.object, "desktop_pairing_session");
    assert.equal(redeemed.body.expires_in_seconds, THIRTY_DAYS_SECONDS);
    assert.equal(redeemed.body.label, "Example laptop");
    const session = redeemed.body.session as string;
    assert.match(session, /^[A-Za-z0-9_-]{43}$/u);
    const expiresMs = Date.parse(redeemed.body.expires_at as string);
    assert.ok(Math.abs(expiresMs - (Date.now() + THIRTY_DAYS_SECONDS * 1000)) < 10_000, "30 day expiry");

    assert.equal(await sessionStatus(asUrl, session), 204);

    const list = (await (
      await fetch(`${asUrl}/owner/sessions`, { headers: { Accept: "application/json", Cookie: cookie } })
    ).json()) as { sessions: Array<{ id: string; label: string; current: boolean }> };
    const paired = list.sessions.find((entry) => entry.label === "Example laptop");
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
      assert.ok(body.link.startsWith("https://vault.example.com/settings#code="));
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

// ── pending codes die with the session that issued them ─────────────────────

async function revokeAll(asUrl: string, cookie: string): Promise<number> {
  const resp = await fetch(`${asUrl}/owner/sessions/revoke-all`, {
    headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
    method: "POST",
  });
  return resp.status;
}

async function ownerSessionLabels(asUrl: string, cookie: string): Promise<string[]> {
  const list = (await (
    await fetch(`${asUrl}/owner/sessions`, { headers: { Accept: "application/json", Cookie: cookie } })
  ).json()) as { sessions: Array<{ label: string }> };
  return list.sessions.map((entry) => entry.label);
}

test("pending_pairing_cannot_restore_access_after_revoke_all", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const issuer = await login(asUrl, TEST_PASSWORD);
    assert.ok(issuer.cookie);
    const pending = (await createPairing(asUrl, issuer.cookie)).body.code;
    assert.equal(await revokeAll(asUrl, issuer.cookie), 204);

    const redeemed = await redeem(asUrl, { code: pending, label: "Stale" });
    assert.equal(redeemed.status, 401, "a code issued by a revoked session must not mint a session");
    assert.deepEqual(redeemed.body, INVALID_CODE_ERROR, "same answer as any other dead code");

    const later = await login(asUrl, TEST_PASSWORD);
    assert.ok(later.cookie);
    assert.deepEqual(
      (await ownerSessionLabels(asUrl, later.cookie)).filter((label) => label === "Stale"),
      [],
      "no session was created"
    );
  });
});

test("desktop pairing: a code is bound to its own issuer, so revoking one session leaves another's code alive", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const first = await login(asUrl, TEST_PASSWORD);
    const second = await login(asUrl, TEST_PASSWORD);
    assert.ok(first.cookie && second.cookie);
    const firstCode = (await createPairing(asUrl, first.cookie)).body.code;
    const secondCode = (await createPairing(asUrl, second.cookie)).body.code;
    const list = (await (
      await fetch(`${asUrl}/owner/sessions`, { headers: { Accept: "application/json", Cookie: second.cookie } })
    ).json()) as { sessions: Array<{ current: boolean; id: string }> };
    const firstPublicId = list.sessions.find((entry) => !entry.current)?.id;
    assert.ok(firstPublicId);
    const revoke = await fetch(`${asUrl}/owner/sessions/${firstPublicId}/revoke`, {
      headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: second.cookie },
      method: "POST",
    });
    assert.equal(revoke.status, 204);

    assert.equal((await redeem(asUrl, { code: firstCode })).status, 401, "the revoked issuer's code is dead");
    assert.equal((await redeem(asUrl, { code: secondCode })).status, 200, "the live issuer's code still works");
  });
});

/** The auth routes on a route table, driven with request shims (no HTTP server). */
function pairingHarness(sessionStore: OwnerSessionStore) {
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-desktop-pairing-race-"));
  const auth = createOwnerAuthPlaceholder({
    instanceIdentity: createInstanceIdentityProvider(dataDir),
    password: TEST_PASSWORD,
    resolvePublicOrigin: () => "https://vault.example.test",
    sessionStore,
  });
  auth.attachRoutes({
    get: (path, handler) => routes.set(`GET ${path}`, handler as never),
    post: (path, handler) => routes.set(`POST ${path}`, handler as never),
  });
  async function call(
    route: string,
    request: { body?: Record<string, unknown>; cookie?: string }
  ): Promise<{ body: Record<string, unknown> | undefined; status: number }> {
    const handler = routes.get(route);
    assert.ok(handler, `${route} is attached`);
    const result: { body: Record<string, unknown> | undefined; status: number } = { body: undefined, status: 200 };
    const headers: Record<string, string | string[]> = {};
    const res = {
      end() {},
      getHeader: (name: string) => headers[name.toLowerCase()],
      json(body: Record<string, unknown>) {
        result.body = body;
        return res;
      },
      redirect() {},
      send() {
        return res;
      },
      setHeader(name: string, value: string | string[]) {
        headers[name.toLowerCase()] = value;
        return res;
      },
      status(code: number) {
        result.status = code;
        return res;
      },
    };
    await handler(
      {
        body: request.body,
        headers: {
          ...(request.cookie ? { cookie: request.cookie } : {}),
          "content-type": "application/json",
        },
        ip: "127.0.0.1",
        method: "POST",
        originalUrl: route,
        url: route,
      },
      res
    );
    return result;
  }
  return { auth, call, dataDir };
}

test("pending_pairing_redeemed_while_revoke_all_runs_ends_up_revoked", async () => {
  const store = createMemoryOwnerSessionStore();
  let holdNextCreate: Promise<void> | null = null;
  let creating: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    creating = resolve;
  });
  const gated: OwnerSessionStore = {
    ...store,
    async createSession(record: OwnerSessionRecord, expectedCredentialRevision?: string) {
      if (holdNextCreate) {
        const hold = holdNextCreate;
        holdNextCreate = null;
        creating();
        await hold;
      }
      return store.createSession(record, expectedCredentialRevision);
    },
  };
  const { call, dataDir } = pairingHarness(gated);
  try {
    // A signed-in owner session, minted through a controller over the same store.
    const controller = createOwnerSessionController({ enabled: true, sessionStore: store });
    const owner = await controller.issueSessionToken({ label: "Browser" }, 3600);
    assert.ok(owner);
    const cookie = `pdpp_owner_session=${owner.sessionId}`;

    const created = await call("POST /owner/desktop-pairings", { cookie });
    assert.equal(created.status, 201);
    const code = created.body?.code as string;

    let release: () => void = () => undefined;
    holdNextCreate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const redeeming = call("POST /owner/desktop-pairings/redeem", { body: { code } });
    await entered; // the redeem is now inside createSession, after its checks passed
    const revoked = await call("POST /owner/sessions/revoke-all", { cookie });
    assert.equal(revoked.status, 204);
    release();

    const outcome = await redeeming;
    assert.equal(outcome.status, 401, "a redeem that finished after revocation must not hand out a session");
    assert.deepEqual(outcome.body, INVALID_CODE_ERROR);
    const live = await store.listSessions(controller.subjectId, Math.floor(Date.now() / 1000));
    assert.deepEqual(live, [], "the session minted during the race was revoked, so nothing is live");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

// ── instance identity ────────────────────────────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyProof(
  proof: { public_key: string; signature: string },
  origin: string,
  nonce: string
): boolean {
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(proof.public_key, "base64url")]),
    format: "der",
    type: "spki",
  });
  return crypto.verify(
    null,
    Buffer.from(instanceProofMessage(origin, nonce)),
    key,
    Buffer.from(proof.signature, "base64url")
  );
}

interface ProofBody {
  fingerprint: string;
  public_key: string;
  signature: string;
}

const NONCE_16 = Buffer.alloc(16, 7).toString("base64url");

/** node:http, because fetch will not let a test choose the Host header. */
function postIdentity(
  asUrl: string,
  nonce: unknown,
  headers: Record<string, string> = {}
): Promise<{ body: Record<string, unknown>; cacheControl: string | undefined; status: number }> {
  const target = new URL(`${asUrl}/owner/desktop-pairings/identity`);
  const payload = JSON.stringify({ nonce });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        hostname: target.hostname,
        method: "POST",
        path: target.pathname,
        port: target.port,
      },
      (resp) => {
        let text = "";
        resp.on("data", (chunk) => {
          text += chunk;
        });
        resp.on("end", () =>
          resolve({
            body: JSON.parse(text) as Record<string, unknown>,
            cacheControl: resp.headers["cache-control"],
            status: resp.statusCode ?? 0,
          })
        );
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test("desktop identity: signs the nonce with a key whose fingerprint create and redeem also return", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    assert.ok(cookie);
    const { body: pairing } = await createPairing(asUrl, cookie);
    const proof = await postIdentity(asUrl, NONCE_16);
    assert.equal(proof.status, 200);
    assert.equal(proof.cacheControl, "no-store");
    const body = proof.body as unknown as ProofBody;
    assert.equal(body.public_key, pairing.server_public_key);
    assert.equal(body.fingerprint, pairing.server_fingerprint);
    assert.equal(body.fingerprint, instanceFingerprint(Buffer.from(body.public_key, "base64url")));
    assert.match(body.public_key, /^[A-Za-z0-9_-]{43}$/u);
    assert.match(body.fingerprint, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/u);
    assert.equal(verifyProof(body, new URL(asUrl).origin, NONCE_16), true);

    const redeemed = await redeem(asUrl, { code: pairing.code });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.body.server_public_key, body.public_key);
    assert.equal(redeemed.body.server_fingerprint, body.fingerprint);
  });
});

test("desktop identity: the signed message binds the origin and the nonce", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const nonce = Buffer.alloc(32, 9).toString("base64url");
    const body = (await postIdentity(asUrl, nonce)).body as unknown as ProofBody;
    const origin = new URL(asUrl).origin;
    assert.equal(verifyProof(body, origin, nonce), true);
    assert.equal(verifyProof(body, "https://other.example.com", nonce), false);
    assert.equal(verifyProof(body, origin, NONCE_16), false);
    const again = (await postIdentity(asUrl, NONCE_16)).body as unknown as ProofBody;
    assert.notEqual(again.signature, body.signature);
    assert.equal(again.public_key, body.public_key, "the key is stable across requests");
  });
});

test("desktop identity: rejects a missing, short, long or non-base64url nonce with 400 invalid_request", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const bad: unknown[] = [
      undefined,
      42,
      "",
      Buffer.alloc(15).toString("base64url"),
      Buffer.alloc(65).toString("base64url"),
      `${NONCE_16}=`,
      "not base64url!!!!!!!!!!!!",
      Buffer.alloc(16, 255).toString("base64"),
    ];
    for (const nonce of bad) {
      const result = await postIdentity(asUrl, nonce);
      assert.equal(result.status, 400, JSON.stringify(nonce));
      assert.equal((result.body.error as { code: string }).code, "invalid_request");
    }
    for (const size of [16, 64]) {
      const result = await postIdentity(asUrl, Buffer.alloc(size, 1).toString("base64url"));
      assert.equal(result.status, 200, `${size} raw bytes is accepted`);
    }
  });
});

test("desktop identity: a created server keeps its identity across a restart on the same data directory", async () => {
  let first = "";
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    first = ((await postIdentity(asUrl, NONCE_16)).body as unknown as ProofBody).public_key;
  });
  assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    assert.equal(((await postIdentity(asUrl, NONCE_16)).body as unknown as ProofBody).public_key, first);
  });
});

// The signed origin is the one the desktop dials. These pin what the resolver
// yields for the Host header, a configured PDPP_REFERENCE_ORIGIN and the
// Docker quickstart configuration (loopback reference origin, trusted hosts
// localhost and 127.0.0.1).

test("desktop identity: with no configured origin the signed origin is the Host the client dialed", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const port = new URL(asUrl).port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const proof = await postIdentity(asUrl, NONCE_16, { Host: host });
      assert.equal(proof.status, 200);
      assert.equal(verifyProof(proof.body as unknown as ProofBody, `http://${host}`, NONCE_16), true, host);
    }
  });
});

test("desktop identity: on a hosted server the signed origin is PDPP_REFERENCE_ORIGIN and an untrusted Host is refused", async () => {
  await withServer(
    {
      ownerAuthPassword: TEST_PASSWORD,
      referenceOrigin: "https://vault.example.com",
      trustedMetadataHosts: "localhost",
    },
    async ({ asUrl }) => {
      const port = new URL(asUrl).port;
      const trusted = await postIdentity(asUrl, NONCE_16, { Host: `localhost:${port}` });
      assert.equal(trusted.status, 200);
      assert.equal(verifyProof(trusted.body as unknown as ProofBody, "https://vault.example.com", NONCE_16), true);
      const untrusted = await postIdentity(asUrl, NONCE_16, { Host: "attacker.example.net" });
      assert.ok(untrusted.status >= 400, "a Host outside the trusted list gets no signature");
      assert.equal(untrusted.body.signature, undefined);
    }
  );
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

test("desktop identity: Docker quickstart configuration signs PDPP_REFERENCE_ORIGIN, whichever loopback name was dialed", async () => {
  const port = await freePort();
  await withServer(
    {
      asPort: port,
      ownerAuthPassword: TEST_PASSWORD,
      referenceOrigin: `http://localhost:${port}`,
      trustedMetadataHosts: "localhost,127.0.0.1",
    },
    async ({ asUrl }) => {
      const { cookie } = await login(asUrl, TEST_PASSWORD);
      assert.ok(cookie);
      const { body: pairing } = await createPairing(asUrl, cookie);
      const observed: string[] = [];
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
        const proof = await postIdentity(asUrl, NONCE_16, { Host: host });
        assert.equal(proof.status, 200, host);
        const body = proof.body as unknown as ProofBody;
        const signed = [`http://localhost:${port}`, `http://127.0.0.1:${port}`].find((origin) =>
          verifyProof(body, origin, NONCE_16)
        );
        observed.push(`Host ${host} signs ${signed}`);
        assert.equal(signed, `http://localhost:${port}`, `quickstart signs the configured origin for Host ${host}`);
      }
      assert.equal(pairing.server_origin, `http://localhost:${port}`);
      console.log(`quickstart (PDPP_REFERENCE_ORIGIN=http://localhost:PORT, trusted localhost,127.0.0.1): ${observed.join("; ")}`);
    }
  );
});
