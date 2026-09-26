// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { getOwnerDeviceAuthorizationByUserCode, initiateOwnerDeviceAuthorization, introspect } from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createOwnerPasswordVerifier } from "../server/owner-password-verifier.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { createOwnerPasswordVerifierStore, setOwnerPassword } from "../server/stores/owner-password-verifier-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const SPOTIFY_MANIFEST = JSON.parse(
  readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
) as {
  connector_id: string;
  [key: string]: unknown;
};

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
const TEST_PASSWORD = "placeholder-test-password";
const CUSTOM_SUBJECT_ID = "owner_testing_custom";
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";
const CSRF_HIDDEN_FIELD_PATTERN = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;
const CONSENT_REQUEST_PATTERN = /Consent request/;

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

interface DrainableController {
  drainActiveRuns?: (timeoutMs: number) => Promise<unknown>;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
  schedulerManager?: { stop?: () => void };
  abortStartupBackfill?: (reason: string) => void;
  startupBackfillDone?: Promise<unknown>;
  controller?: DrainableController;
};

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.("test shutdown");
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const backfillDone = server.startupBackfillDone
    ? new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        Promise.resolve(server.startupBackfillDone)
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(timer);
            resolve();
          });
      })
    : Promise.resolve();
  const closeWithTimeout = (srv: CloseableServer) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);
      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([
    closeWithTimeout(server.asServer),
    closeWithTimeout(server.rsServer),
    backfillDone,
    server.controller?.drainActiveRuns
      ? server.controller.drainActiveRuns(1000).catch(() => undefined)
      : Promise.resolve(),
  ]);
  closeDb();
}

async function withServer(
  opts: Record<string, unknown>,
  fn: (ctx: { asUrl: string; rsUrl: string }) => Promise<void>
): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
    ...opts,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

async function startPendingConsent(
  asUrl: string,
  overrides: Record<string, unknown> = {},
  instanceOwnerSubjectIds: readonly string[] = [OWNER_SUBJECT_ID, CUSTOM_SUBJECT_ID]
): Promise<string> {
  const registerResp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(SPOTIFY_MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!registerResp.ok) {
    const text = await registerResp.text();
    throw new Error(`connector registration failed: ${registerResp.status} ${text}`);
  }
  await seedSpotifyInstance(instanceOwnerSubjectIds);
  const resp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "single_use",
          purpose_code: "https://pdpp.dev/purpose/test",
          purpose_description: "test",
          source: { id: SPOTIFY_MANIFEST.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_display: { name: "Longview" },
      client_id: "longview",
      ...overrides,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`par failed: ${resp.status} ${text}`);
  }
  const body = (await resp.json()) as { request_uri?: string };
  if (!body.request_uri) {
    throw new Error(`par did not return request_uri: ${JSON.stringify(body)}`);
  }
  return body.request_uri;
}

async function reviewPendingConsent(
  asUrl: string,
  requestUri: string,
  cookie: string,
  subjectId?: string
): Promise<string> {
  const resp = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({
      request_uri: requestUri,
      ...(subjectId ? { subject_id: subjectId } : {}),
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    method: "POST",
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  const body = JSON.parse(text) as {
    approval_review?: object;
    approval_review_revision?: string;
    request_uri?: string;
  };
  assert.ok(body.approval_review);
  assert.ok(body.approval_review_revision);
  assert.equal(body.request_uri, requestUri);
  return body.approval_review_revision;
}

async function seedSpotifyInstance(
  ownerSubjectIds: readonly string[] = [OWNER_SUBJECT_ID, CUSTOM_SUBJECT_ID]
): Promise<void> {
  const connectorId = canonicalConnectorKey(SPOTIFY_MANIFEST.connector_id);
  assert.ok(connectorId, "spotify manifest must resolve to a canonical connector key");
  const store = createSqliteConnectorInstanceStore();
  await Promise.all(
    ownerSubjectIds.map((ownerSubjectId) =>
      store.upsert({
        connectorId,
        connectorInstanceId: `cin_owner_auth_spotify_${ownerSubjectId}`,
        createdAt: NOW,
        displayName: "Owner Auth Spotify",
        ownerSubjectId,
        sourceBinding: { account_hint: `${ownerSubjectId}@example.com` },
        sourceBindingKey: `${ownerSubjectId}@example.com`,
        sourceKind: "account",
        status: "active",
        updatedAt: NOW,
      })
    )
  );
}

function getRawSetCookieList(resp: Response): string[] {
  // node:fetch's Headers.getSetCookie() returns the full per-cookie list
  // (each value as a separate string) instead of the joined comma-list
  // that .get('set-cookie') yields.
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: readonly string[], name: string): string | null {
  for (const header of setCookies) {
    const [firstPair] = header.split(";");
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractSessionCookie(setCookieList: readonly string[] | null | undefined): string | null {
  if (!setCookieList) {
    return null;
  }
  const list = Array.isArray(setCookieList) ? setCookieList : [setCookieList];
  return findSetCookiePair(list, "pdpp_owner_session");
}

function extractCsrfFieldValue(html: string): string | null {
  // The hidden field renderer in owner-csrf.ts emits exactly:
  //   <input type="hidden" name="_csrf" value="..." />
  const match = html.match(CSRF_HIDDEN_FIELD_PATTERN);
  return match?.[1] ?? null;
}

interface CsrfResult {
  csrfCookie: string | null;
  csrfField: string | null;
  html: string;
  status: number;
}

async function fetchCsrf(asUrl: string, path = "/owner/login"): Promise<CsrfResult> {
  const resp = await fetch(`${asUrl}${path}`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const setCookies = getRawSetCookieList(resp);
  const csrfCookie = findSetCookiePair(setCookies, "pdpp_owner_csrf");
  const html = await resp.text();
  const csrfField = extractCsrfFieldValue(html);
  return {
    csrfCookie,
    csrfField,
    html,
    status: resp.status,
  };
}

interface LoginResult {
  cookie: string | null;
  csrfCookie: string | null;
  csrfField: string | null;
  location: string | null;
  retryAfter: string | null;
  setCookies: string[];
  status: number;
}

async function login(asUrl: string, password: string, { returnTo = "/consent" } = {}): Promise<LoginResult> {
  const csrf = await fetchCsrf(asUrl, "/owner/login");
  const body = new URLSearchParams({
    _csrf: csrf.csrfField || "",
    password,
    return_to: returnTo,
  });
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: body.toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrf.csrfCookie || "",
    },
    method: "POST",
    redirect: "manual",
  });
  const setCookies = getRawSetCookieList(resp);
  const sessionCookie = extractSessionCookie(setCookies);
  return {
    cookie: sessionCookie,
    csrfCookie: csrf.csrfCookie,
    csrfField: csrf.csrfField,
    location: resp.headers.get("location"),
    retryAfter: resp.headers.get("retry-after"),
    setCookies,
    status: resp.status,
  };
}

interface HostedFormCsrfResult extends CsrfResult {
  setCookies: string[];
}

async function fetchHostedFormCsrf(
  asUrl: string,
  path: string,
  sessionCookie: string | null
): Promise<HostedFormCsrfResult> {
  const resp = await fetch(`${asUrl}${path}`, {
    headers: { Accept: "text/html", Cookie: sessionCookie || "" },
    redirect: "manual",
  });
  const setCookies = getRawSetCookieList(resp);
  const csrfCookie = findSetCookiePair(setCookies, "pdpp_owner_csrf");
  const html = await resp.text();
  const csrfField = extractCsrfFieldValue(html);
  return { csrfCookie, csrfField, html, setCookies, status: resp.status };
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

// ── 1. disabled: unchanged open local-dev behavior ───────────────────────────
test("owner-auth placeholder: when PDPP_OWNER_PASSWORD unset, /consent and /device remain open", async () => {
  await withServer({}, async ({ asUrl }) => {
    const loginPage = await fetch(`${asUrl}/owner/login`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(loginPage.status, 200, "/owner/login should stay discoverable even when auth is disabled");
    const loginHtml = await loginPage.text();
    assert.ok(loginHtml.includes("owner access"), "renders owner-access landing copy");
    assert.ok(loginHtml.includes("No owner password is set"), "explains that owner sign-in is off");
    assert.ok(loginHtml.includes("/device"), "offers a stable device-approval entry point");
    assert.ok(!loginHtml.includes("Owner password"), "does not render a password form when disabled");

    const requestUri = await startPendingConsent(asUrl);

    const consent = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(consent.status, 200, "consent page should render directly");
    const consentText = await consent.text();
    assert.ok(consentText.includes("Consent request"), "renders consent body");
    assert.ok(consentText.includes("Longview"), "renders client details");

    const device = await initiateOwnerDeviceAuthorization("longview", {
      baseUrl: asUrl,
    });
    const devicePage = await fetch(`${asUrl}/device?user_code=${device.user_code}`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(devicePage.status, 200);
    const deviceText = await devicePage.text();
    assert.ok(deviceText.includes("Subject ID"), "unauth mode shows freeform subject id field");
  });
});

test("hosted first run stays locked until /setup claims the install once", async () => {
  const setupToken = "setup-token-for-owner-claim";
  const password = "a newly chosen owner password";
  await withServer(
    {
      referenceOrigin: "https://setup.example.test",
      trustedMetadataHosts: "localhost",
      ownerSetupToken: setupToken,
    },
    async ({ asUrl }) => {
      const setupPage = await fetch(`${asUrl}/setup`);
      assert.equal(setupPage.status, 200, await setupPage.text());
      assert.equal((await fetch(`${asUrl}/owner/session`)).status, 401, "owner gate is closed before claim");
      const loginBeforeClaim = await fetch(`${asUrl}/owner/login`, {
        redirect: "manual",
      });
      assert.equal(loginBeforeClaim.status, 302);
      assert.equal(loginBeforeClaim.headers.get("location"), "/setup");

      const postClaim = (token: string) =>
        fetch(`${asUrl}/setup`, {
          body: new URLSearchParams({ token, password }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
      assert.equal((await postClaim("wrong-token")).status, 403);
      assert.equal((await postClaim(setupToken)).status, 201);
      assert.equal((await postClaim(setupToken)).status, 403, "claim token is one-time");

      const signedIn = await login(asUrl, password);
      assert.equal(signedIn.status, 302, "new verifier activates owner login without a restart");
      assert.ok(signedIn.cookie);
    }
  );
});

test("owner-auth-required loopback first run stays locked until /setup claims the install once", async () => {
  const setupToken = "loopback-required-setup-token";
  const password = "a newly chosen loopback owner password";
  const previousRequired = process.env.PDPP_OWNER_AUTH_REQUIRED;
  process.env.PDPP_OWNER_AUTH_REQUIRED = "1";
  try {
    await withServer(
      {
        referenceOrigin: "http://localhost:3200",
        trustedMetadataHosts: "localhost",
        ownerSetupToken: setupToken,
      },
      async ({ asUrl }) => {
        const setupPage = await fetch(`${asUrl}/setup`);
        assert.equal(setupPage.status, 200, await setupPage.text());
        assert.equal((await fetch(`${asUrl}/owner/session`)).status, 401, "owner gate is closed before claim");
        const loginBeforeClaim = await fetch(`${asUrl}/owner/login`, {
          redirect: "manual",
        });
        assert.equal(loginBeforeClaim.status, 302);
        assert.equal(loginBeforeClaim.headers.get("location"), "/setup");

        const claimed = await fetch(`${asUrl}/setup`, {
          body: new URLSearchParams({ token: setupToken, password }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        assert.equal(claimed.status, 201);

        const signedIn = await login(asUrl, password);
        assert.equal(signedIn.status, 302, "new verifier activates owner login without a restart");
        assert.ok(signedIn.cookie);
      }
    );
  } finally {
    if (previousRequired === undefined) delete process.env.PDPP_OWNER_AUTH_REQUIRED;
    else process.env.PDPP_OWNER_AUTH_REQUIRED = previousRequired;
  }
});

test("public console /setup proxies the first-run form claim to the loopback AS", async (t) => {
  const previousAsUrl = process.env.PDPP_AS_URL;
  t.after(() => {
    if (previousAsUrl === undefined) delete process.env.PDPP_AS_URL;
    else process.env.PDPP_AS_URL = previousAsUrl;
  });

  // Keep the console route outside this package's NodeNext type program while
  // exercising the exact public handler at runtime.
  const loadModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{
    GET: (request: Request) => Promise<Response>;
    POST: (request: Request) => Promise<Response>;
  }>;
  const publicRoute = await loadModule(new URL("../../apps/console/src/app/setup/route.ts", import.meta.url).href);
  const setupToken = "public-console-setup-token";
  const password = "password claimed through public console";
  await withServer(
    {
      referenceOrigin: "https://setup.example.test",
      trustedMetadataHosts: "localhost",
      ownerSetupToken: setupToken,
    },
    async ({ asUrl }) => {
      process.env.PDPP_AS_URL = asUrl;
      const publicUrl = "https://setup.example.test/setup";
      const setupPage = await publicRoute.GET(new Request(publicUrl, { headers: { Accept: "text/html" } }));
      assert.equal(setupPage.status, 200);
      assert.match(await setupPage.text(), /Claim this install/);

      const formRequest = () =>
        new Request(publicUrl, {
          body: new URLSearchParams({ token: setupToken, password }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
      const claimed = await publicRoute.POST(formRequest());
      assert.equal(claimed.status, 201, await claimed.text());
      assert.equal((await publicRoute.POST(formRequest())).status, 403, "setup token is consumed once");
      assert.equal((await login(asUrl, password)).status, 302, "the claim enables owner login immediately");
    }
  );
});

test("setup throttles wrong tokens and does not override an environment password", async () => {
  await withServer(
    {
      referenceOrigin: "https://setup.example.test",
      trustedMetadataHosts: "localhost",
      ownerSetupToken: "setup-token-for-owner-claim",
      ownerAuthLoginRateLimit: { max: 1, maxLocal: 1, windowMs: 60_000 },
    },
    async ({ asUrl }) => {
      const submit = () =>
        fetch(`${asUrl}/setup`, {
          body: new URLSearchParams({
            token: "wrong",
            password: "a sufficiently long password",
          }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
      assert.equal((await submit()).status, 403);
      assert.equal((await submit()).status, 429);
    }
  );

  await withServer(
    {
      referenceOrigin: "https://setup.example.test",
      trustedMetadataHosts: "localhost",
      ownerSetupToken: "should-not-be-used",
      ownerAuthPassword: TEST_PASSWORD,
    },
    async ({ asUrl }) => {
      assert.equal((await fetch(`${asUrl}/setup`)).status, 404);
      assert.equal((await login(asUrl, TEST_PASSWORD)).status, 302);
    }
  );
});

test("owner-auth placeholder: open local-dev HTML display defers subject-bound resolution to JSON review", async () => {
  const customSubjectId = "u1";
  await withServer({}, async ({ asUrl }) => {
    const requestUri = await startPendingConsent(asUrl, {}, [customSubjectId]);

    const display = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    const displayHtml = await display.text();
    assert.equal(display.status, 200, displayHtml);
    assert.match(displayHtml, CONSENT_REQUEST_PATTERN);

    const review = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({
        request_uri: requestUri,
        subject_id: customSubjectId,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const reviewText = await review.text();
    assert.equal(review.status, 200, reviewText);
    const reviewBody = JSON.parse(reviewText) as {
      approval_review?: { subject?: { id?: string } };
      approval_review_revision?: string;
    };
    assert.equal(reviewBody.approval_review?.subject?.id, customSubjectId, "review binds the submitted subject");
    assert.ok(reviewBody.approval_review_revision, "review materializes a revision");

    const approved = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: reviewBody.approval_review_revision,
        request_uri: requestUri,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const approvedText = await approved.text();
    assert.equal(approved.status, 200, approvedText);
    const approvedBody = JSON.parse(approvedText) as {
      grant?: {
        streams?: Array<{ instance_ids?: string[] }>;
        subject?: { id?: string };
      };
    };
    assert.equal(
      approvedBody.grant?.subject?.id,
      customSubjectId,
      "revision-only approval preserves the reviewed subject"
    );
    assert.deepEqual(approvedBody.grant?.streams?.[0]?.instance_ids, [`cin_owner_auth_spotify_${customSubjectId}`]);
  });
});

// ── 2. enabled: unauthenticated HTML requests redirect to /owner/login ────────
test("owner-auth placeholder: enabled — unauthenticated /consent and /device redirect to /owner/login", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const requestUri = await startPendingConsent(asUrl);

    const consent = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(consent.status, 302);
    const loc = consent.headers.get("location");
    assert.ok(loc?.startsWith("/owner/login?return_to="), `expected login redirect, got ${loc}`);
    assert.ok(loc, "expected a redirect location");
    assert.ok(loc.includes(encodeURIComponent("/consent")), "return_to points back to /consent");

    const device = await fetch(`${asUrl}/device`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(device.status, 302);
    assert.ok(device.headers.get("location")?.startsWith("/owner/login?return_to="));

    const approveRefererPath = `/consent?request_uri=${encodeURIComponent(requestUri)}`;
    const approve = await fetch(`${asUrl}/consent/approve`, {
      body: new URLSearchParams({ request_uri: requestUri }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${asUrl}${approveRefererPath}`,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approve.status, 302);
    assert.ok(
      approve.headers.get("location")?.includes(encodeURIComponent(approveRefererPath)),
      "HTML POST redirects back to the originating consent page after login"
    );

    // non-HTML callers get 401 JSON, not a redirect
    const deviceJson = await fetch(`${asUrl}/device`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    assert.equal(deviceJson.status, 401);
    const jsonBody = (await deviceJson.json()) as { error?: { code?: string } };
    assert.equal(jsonBody.error?.code, "owner_session_required");
  });
});

// ── 3. wrong password does not issue a session ───────────────────────────────
test("owner-auth placeholder: wrong password with valid CSRF returns 401 and issues no cookie", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const csrf = await fetchCsrf(asUrl, "/owner/login");
    assert.ok(csrf.csrfField, "login GET embeds a CSRF token field");
    assert.ok(csrf.csrfCookie?.startsWith("pdpp_owner_csrf="), "login GET sets a CSRF cookie");

    const resp = await fetch(`${asUrl}/owner/login`, {
      body: new URLSearchParams({
        _csrf: csrf.csrfField,
        password: "wrong",
        return_to: "/consent",
      }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: csrf.csrfCookie || "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 401);
    const setCookies = getRawSetCookieList(resp);
    assert.ok(!findSetCookiePair(setCookies, "pdpp_owner_session"), "no session cookie on wrong password");
    const text = await resp.text();
    assert.ok(text.includes("Incorrect password"), "login page shows error");
  });
});

test("owner-auth placeholder accepts an app-managed scrypt verifier", async () => {
  const password = "app managed owner password";
  const ownerAuthPasswordVerifier = await createOwnerPasswordVerifier(password);
  await withServer({ ownerAuthLoginRateLimit: false, ownerAuthPasswordVerifier }, async ({ asUrl }) => {
    const result = await login(asUrl, password);
    assert.equal(result.status, 302);
    assert.ok(result.cookie?.startsWith("pdpp_owner_session="), "successful verifier check issues a session");

    const wrong = await login(asUrl, "different app managed password");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.cookie, null, "wrong password does not issue a session");
  });
});

test("owner-auth loads a database verifier before hosted posture and login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-owner-password-startup-"));
  const dbPath = join(dir, "pdpp.sqlite");
  const password = "persisted app managed password";
  initDb(dbPath);
  try {
    await setOwnerPassword(createOwnerPasswordVerifierStore(), password);
  } finally {
    closeDb();
  }

  try {
    await withServer({ dbPath }, async ({ asUrl }) => {
      assert.equal((await login(asUrl, password)).status, 302);
      assert.equal((await login(asUrl, "not the persisted password")).status, 401);
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("owner-auth uses the configured password when both password sources are present", async () => {
  const environmentPassword = "operator environment password";
  const verifierPassword = "database owner password";
  const ownerAuthPasswordVerifier = await createOwnerPasswordVerifier(verifierPassword);
  await withServer(
    {
      ownerAuthLoginRateLimit: false,
      ownerAuthPassword: environmentPassword,
      ownerAuthPasswordVerifier,
    },
    async ({ asUrl }) => {
      assert.equal((await login(asUrl, environmentPassword)).status, 302);
      assert.equal((await login(asUrl, verifierPassword)).status, 401);
    }
  );
});

test("owner-auth consumes a legacy password file even when the configured password wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-owner-password-env-migration-"));
  const dbPath = join(dir, "pdpp.sqlite");
  const legacyPasswordPath = join(dir, "owner-password");
  const legacyPassword = "legacy generated owner password";
  const environmentPassword = "operator environment password";
  await writeFile(legacyPasswordPath, `${legacyPassword}\n`, { mode: 0o600 });

  try {
    await withServer({ dbPath, ownerAuthPassword: environmentPassword }, async ({ asUrl }) => {
      assert.equal((await login(asUrl, environmentPassword)).status, 302);
      assert.equal((await login(asUrl, legacyPassword)).status, 401);
      await assert.rejects(readFile(legacyPasswordPath), { code: "ENOENT" });
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// ── 3a. sign-in page copy: product identity, no operator detail ──────────────
// The sign-in page is the auth gate for local and server-exposed instances
// alike. It names the product, says what the password protects, and keeps
// operator configuration (env vars, logout route) in the README instead.
const SIGN_IN_FORBIDDEN_COPY = [
  "placeholder",
  "reference implementation",
  "Reference Provider",
  "not a full auth product",
  "PDPP_OWNER_PASSWORD",
  "/owner/logout",
];

function assertOwnerSignInCopy(html: string): void {
  assert.match(html, /<title>DataConnect — Owner sign-in<\/title>/);
  assert.match(html, /<span class="hosted-ui-provider" aria-label="Provider">DataConnect<\/span>/);
  assert.match(html, /<h1 id="hosted-ui-page-title" class="pdpp-display">Sign in to DataConnect<\/h1>/);
  assert.ok(
    html.includes("This password keeps other people from seeing your data or changing which apps can use it."),
    "says what the password protects"
  );
  assert.ok(!html.includes("hosted-ui-instance-monogram"), "an unnamed instance shows no instance monogram");
  for (const phrase of SIGN_IN_FORBIDDEN_COPY) {
    assert.ok(!html.includes(phrase), `sign-in page must not say ${JSON.stringify(phrase)}`);
  }
}

test("owner-auth: sign-in page names DataConnect and prints no operator detail", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const page = await fetch(`${asUrl}/owner/login`, {
      headers: { Accept: "text/html" },
    });
    assert.equal(page.status, 200);
    assertOwnerSignInCopy(await page.text());

    const csrf = await fetchCsrf(asUrl, "/owner/login");
    const wrong = await fetch(`${asUrl}/owner/login`, {
      body: new URLSearchParams({
        _csrf: csrf.csrfField ?? "",
        password: "wrong",
        return_to: "/",
      }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: csrf.csrfCookie || "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(wrong.status, 401);
    const html = await wrong.text();
    assert.match(html, /<div class="hosted-ui-error" role="alert">Incorrect password\.<\/div>/);
    assertOwnerSignInCopy(html);
  });
});

// ── 3b. login-attempt throttling: repeated failures trip, and the owner ──────
//        recovers without any operator/admin action ─────────────────────────
test("owner-auth placeholder: repeated failed logins are throttled with a Retry-After", async () => {
  await withServer(
    {
      ownerAuthLoginRateLimit: { max: 2, maxLocal: 2, windowMs: 60_000 },
      ownerAuthPassword: TEST_PASSWORD,
    },
    async ({ asUrl }) => {
      const attempt1 = await login(asUrl, "wrong-1");
      assert.equal(attempt1.status, 401, "first wrong attempt is a normal 401");
      const attempt2 = await login(asUrl, "wrong-2");
      assert.equal(attempt2.status, 401, "second wrong attempt is still a normal 401");

      const throttled = await login(asUrl, "wrong-3");
      assert.equal(throttled.status, 429, "third attempt within the window is throttled, not evaluated");
      assert.ok(throttled.retryAfter, "429 response carries a Retry-After header");

      const stillThrottled = await login(asUrl, "wrong-4");
      assert.equal(stillThrottled.status, 429, "throttling persists across further attempts within the window");
    }
  );
});

test("owner-auth placeholder: the legitimate owner is never permanently stranded — correct password clears the throttle immediately", async () => {
  await withServer(
    {
      ownerAuthLoginRateLimit: { max: 2, maxLocal: 2, windowMs: 60_000 },
      ownerAuthPassword: TEST_PASSWORD,
    },
    async ({ asUrl }) => {
      await login(asUrl, "wrong-1");
      const successAfterOneMiss = await login(asUrl, TEST_PASSWORD);
      assert.equal(successAfterOneMiss.status, 302, "owner can still recover a typo without being throttled");
      assert.ok(successAfterOneMiss.cookie?.startsWith("pdpp_owner_session="), "successful login issues a session");

      // A subsequent sign-out-and-back-in cycle is not left waiting out the
      // rest of the original window: a correct password clears the throttle
      // for that key immediately (owner-login-rate-limit.test.ts covers this
      // at the unit level; this proves it end to end through /owner/login).
      const secondLogin = await login(asUrl, TEST_PASSWORD);
      assert.equal(secondLogin.status, 302, "owner can sign in again without hitting a stale throttle");
    }
  );
});

test("owner-auth placeholder: throttling never applies to the disabled (no-password) posture", async () => {
  await withServer({ ownerAuthLoginRateLimit: { max: 1, maxLocal: 1, windowMs: 60_000 } }, async ({ asUrl }) => {
    // Owner auth is disabled (no password configured) — /owner/login should
    // show the disabled page every time, never a 429, regardless of how many
    // times it's requested.
    for (let i = 0; i < 3; i += 1) {
      const resp = await fetch(`${asUrl}/owner/login`, {
        headers: { Accept: "text/html" },
      });
      assert.equal(resp.status, 200, `GET /owner/login #${i + 1} while disabled is never throttled`);
    }
  });
});

// ── 4. correct password issues a valid opaque session cookie ─────────────────
test("owner-auth placeholder: correct password issues a session cookie and redirects to return_to", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { status, cookie, location } = await login(asUrl, TEST_PASSWORD);
    assert.equal(status, 302);
    assert.equal(location, "/consent");
    assert.ok(cookie?.startsWith("pdpp_owner_session="), "session cookie set");

    // An authenticated GET /consent with the same cookie no longer redirects.
    const requestUri = await startPendingConsent(asUrl);
    const resp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`, {
      headers: { Accept: "text/html", Cookie: cookie || "" },
      redirect: "manual",
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes("Consent request"));
    assert.ok(text.includes("Longview"));
  });
});

test("owner-auth placeholder: authenticated GET /owner/login becomes a signed-in landing page", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const resp = await fetch(`${asUrl}/owner/login`, {
      headers: { Accept: "text/html", Cookie: cookie || "" },
      redirect: "manual",
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes("Signed in"), "shows signed-in state");
    assert.ok(text.includes('href="/"'), "offers a path back to the owner console");
    assert.ok(text.includes("/device"), "offers a stable device approval entry point");
    assert.ok(text.includes("owner_local"), "shows the current owner subject");
  });
});

// ── 5. authenticated approval/deny/device flows work end-to-end ──────────────
test("owner-auth placeholder: authenticated /consent/approve issues a grant and token", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);
    const approvalReviewRevision = await reviewPendingConsent(asUrl, requestUri, cookie || "");

    const approveResp = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: approvalReviewRevision,
        request_uri: requestUri,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: cookie || "",
      },
      method: "POST",
    });
    assert.equal(approveResp.status, 200);
    const body = (await approveResp.json()) as {
      grant_id?: string;
      token?: string;
    };
    assert.ok(body.grant_id, "grant issued");
    assert.ok(body.token, "owner/app token issued");
    const tokenRows = getDb().prepare("SELECT subject_id FROM tokens WHERE grant_id = ?").all(body.grant_id) as {
      subject_id: string;
    }[];
    assert.ok(tokenRows.length >= 1);
    assert.equal(tokenRows[0]?.subject_id, "owner_local", "default subject used");
  });

  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    const denyResp = await fetch(`${asUrl}/consent/deny`, {
      body: JSON.stringify({ request_uri: requestUri }),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/json",
        Cookie: cookie || "",
      },
      method: "POST",
    });
    assert.equal(denyResp.status, 200, "deny succeeds with session");
  });

  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization("longview", {
      baseUrl: asUrl,
    });
    const userCode = device.user_code;
    assert.ok(typeof userCode === "string", "device authorization returns a user code");

    // Fetch the device approval page to capture the rendered CSRF token
    // and matching cookie. The signed token must be paired with the
    // matching cookie or the form POST is rejected.
    const csrf = await fetchHostedFormCsrf(asUrl, `/device?user_code=${encodeURIComponent(userCode)}`, cookie);
    const { csrfField } = csrf;
    assert.ok(typeof csrfField === "string", "/device GET embeds a CSRF token");
    assert.ok(csrf.csrfCookie?.startsWith("pdpp_owner_csrf="), "/device GET sets a CSRF cookie");

    const approveDeviceResp = await fetch(`${asUrl}/device/approve`, {
      body: new URLSearchParams({
        _csrf: csrfField,
        user_code: userCode,
      }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${cookie}; ${csrf.csrfCookie}`,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approveDeviceResp.status, 200);
    const pending = await getOwnerDeviceAuthorizationByUserCode(userCode);
    assert.equal(pending, null, "pending row cleared after approval");
  });
});

// ── 6. enabled: submitted subject_id is ignored, configured subject wins ─────
test("owner-auth placeholder: enabled — submitted subject_id is ignored during consent review", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD, ownerAuthSubjectId: CUSTOM_SUBJECT_ID }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl, {}, [CUSTOM_SUBJECT_ID]);
    const display = await fetch(
      `${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}&subject_id=attacker_injected_subject`,
      {
        headers: { Accept: "text/html", Cookie: cookie || "" },
        redirect: "manual",
      }
    );
    assert.equal(display.status, 200, await display.text());
    const approvalReviewRevision = await reviewPendingConsent(
      asUrl,
      requestUri,
      cookie || "",
      "attacker_injected_subject"
    );

    const resp = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: approvalReviewRevision,
        request_uri: requestUri,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: cookie || "",
      },
      method: "POST",
    });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { grant_id?: string };
    const tokenRows = getDb().prepare("SELECT subject_id FROM tokens WHERE grant_id = ?").all(body.grant_id) as {
      subject_id: string;
    }[];
    assert.ok(tokenRows.length >= 1);
    assert.equal(
      tokenRows[0]?.subject_id,
      CUSTOM_SUBJECT_ID,
      "submitted subject_id must be ignored and configured owner subject used"
    );
  });

  // and on /device/approve the configured subject is persisted into the owner session
  await withServer({ ownerAuthPassword: TEST_PASSWORD, ownerAuthSubjectId: CUSTOM_SUBJECT_ID }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization("longview", {
      baseUrl: asUrl,
    });
    const userCode = device.user_code;
    assert.ok(typeof userCode === "string", "device authorization returns a user code");

    const csrf = await fetchHostedFormCsrf(asUrl, `/device?user_code=${encodeURIComponent(userCode)}`, cookie);
    const { csrfField } = csrf;
    assert.ok(typeof csrfField === "string", "/device GET embeds a CSRF token");
    const approveDeviceResp = await fetch(`${asUrl}/device/approve`, {
      body: new URLSearchParams({
        _csrf: csrfField,
        subject_id: "attacker_injected_subject",
        user_code: userCode,
      }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${cookie}; ${csrf.csrfCookie}`,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approveDeviceResp.status, 200);

    const rows = getDb()
      .prepare(
        `
        SELECT subject_id FROM tokens
        WHERE token_kind = 'owner'
        ORDER BY created_at DESC
    `
      )
      .all();
    const [ownerTokenRow] = rows;
    assert.ok(ownerTokenRow, "owner token row exists");
    assert.equal(ownerTokenRow.subject_id, CUSTOM_SUBJECT_ID);
  });
});

// ── 7. non-protected public routes still behave as before ────────────────────
test("owner-auth placeholder: public OAuth metadata and /oauth/par routes are not gated", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const meta = await fetch(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(meta.status, 200);
    const metaBody = (await meta.json()) as { issuer?: string };
    assert.ok(metaBody.issuer, "metadata still returned without owner session");

    // /oauth/par accepts requests without an owner session (client-side flow).
    const requestUri = await startPendingConsent(asUrl);
    assert.ok(typeof requestUri === "string" && requestUri.length > 0);
  });
});

test("owner-auth placeholder: enabled — _ref reads and mutations both require owner session", async () => {
  // Per gate-ref-reads-when-owner-auth-enabled, both `_ref` reads and
  // mutations are owner-gated when PDPP_OWNER_PASSWORD is set.
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    await startPendingConsent(asUrl);
    const connectorId = SPOTIFY_MANIFEST.connector_id;

    const unauthenticatedRead = await fetchJson(`${asUrl}/_ref/connectors?limit=20`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(unauthenticatedRead.status, 401, "_ref reads now require owner session");
    assert.equal((unauthenticatedRead.body as { error?: { code?: string } }).error?.code, "owner_session_required");

    const unauthenticatedMutation = await fetchJson(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`,
      {
        body: JSON.stringify({ enabled: true, interval_seconds: 300 }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        method: "PUT",
      }
    );
    assert.equal(unauthenticatedMutation.status, 401);
    assert.equal((unauthenticatedMutation.body as { error?: { code?: string } }).error?.code, "owner_session_required");

    const { cookie } = await login(asUrl, TEST_PASSWORD);

    const authenticatedRead = await fetchJson(`${asUrl}/_ref/connectors?limit=20`, {
      headers: { Accept: "application/json", Cookie: cookie || "" },
    });
    assert.equal(authenticatedRead.status, 200, "_ref read succeeds with owner session");
    assert.equal((authenticatedRead.body as { object?: string }).object, "list");

    const authenticatedMutation = await fetchJson(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`,
      {
        body: JSON.stringify({ enabled: true, interval_seconds: 300 }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: cookie || "",
        },
        method: "PUT",
      }
    );
    assert.equal(authenticatedMutation.status, 200);
    const authenticatedMutationBody = authenticatedMutation.body as {
      connector_id?: string;
      interval_seconds?: number;
    };
    // Schedule writes canonicalize URL-shaped connector ids to short keys.
    assert.equal(authenticatedMutationBody.connector_id, canonicalConnectorKey(connectorId));
    assert.equal(authenticatedMutationBody.interval_seconds, 300);
  });
});

// ── extra: logout clears the cookie ──────────────────────────────────────────
test("owner-auth placeholder: logout clears the session cookie", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    // JSON callers logout with `Content-Type: application/json` to
    // signal "programmatic, not a browser form post." That is what
    // exempts the request from CSRF; an empty body with no
    // Content-Type would otherwise look indistinguishable from a
    // cross-origin browser POST and would now be rejected.
    const resp = await fetch(`${asUrl}/owner/logout`, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: cookie || "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 204);
    const setCookie = resp.headers.get("set-cookie");
    assert.ok(setCookie?.includes("pdpp_owner_session="), "sets clearing cookie");
    assert.ok(setCookie?.includes("Max-Age=0"), "cookie is expired");

    const reused = await fetch(`${asUrl}/owner/session`, {
      headers: { Accept: "application/json", Cookie: cookie || "" },
      redirect: "manual",
    });
    assert.equal(reused.status, 401, "logout revokes the server-side session record");
  });
});

// ── /owner/session: the admission check a cookie-forwarding server asks ──────
test("owner-auth placeholder: enabled — GET /owner/session admits only a valid session", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const check = (cookie?: string) =>
      fetch(`${asUrl}/owner/session`, {
        headers: {
          Accept: "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        redirect: "manual",
      });

    const anonymous = await check();
    assert.equal(anonymous.status, 401);
    assert.equal(((await anonymous.json()) as { error?: { code?: string } }).error?.code, "owner_session_required");

    const { cookie } = await login(asUrl, TEST_PASSWORD);
    assert.ok(cookie);
    const admitted = await check(cookie);
    assert.equal(admitted.status, 204);
    assert.equal(await admitted.text(), "");

    const tampered = await check(`${cookie}x`);
    assert.equal(tampered.status, 401);
  });
});

test("owner-auth placeholder: disabled on loopback — GET /owner/session admits open local dev", async () => {
  await withServer({}, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/session`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(resp.status, 204);
  });
});

test("owner-auth: session inventory lists revocable devices and owner device-flow bearers without exposing bearer values", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const first = await login(asUrl, TEST_PASSWORD);
    const second = await login(asUrl, TEST_PASSWORD);
    assert.ok(first.cookie && second.cookie);

    const tokenValue = "owner-device-flow-secret-for-session-inventory-test";
    getDb()
      .prepare(
        "INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at) VALUES(?, NULL, ?, ?, 'owner', ?)"
      )
      .run(tokenValue, OWNER_SUBJECT_ID, "inventory-test-client", new Date(Date.now() + 60_000).toISOString());

    const list = await fetchJson(`${asUrl}/owner/sessions`, {
      headers: { Accept: "application/json", Cookie: first.cookie },
    });
    assert.equal(list.status, 200);
    const body = list.body as {
      sessions: Array<{
        id: string;
        label: string;
        createdAt: number;
        lastSeenAt: number;
        ipAddress: string | null;
        current: boolean;
      }>;
      bearers: Array<{
        id: string;
        label: string;
        createdAt: string;
        expiresAt: string | null;
      }>;
    };
    assert.equal(body.sessions.length, 2);
    assert.ok(body.sessions.every((session) => session.label.length > 0));
    assert.ok(
      body.sessions.every((session) => Number.isFinite(session.createdAt) && Number.isFinite(session.lastSeenAt))
    );
    assert.equal(body.sessions.filter((session) => session.current).length, 1);
    assert.ok(body.sessions.find((session) => session.current)?.ipAddress, "the AS records the peer IP");
    assert.equal(body.bearers.length, 1);
    assert.match(body.bearers[0]?.id ?? "", /^tok_[A-Za-z0-9_-]{43}$/u);
    assert.ok(body.bearers[0]?.createdAt.endsWith("Z"), "database timestamps are projected as explicit UTC values");
    assert.doesNotMatch(JSON.stringify(body), new RegExp(tokenValue, "u"), "the bearer secret never leaves the AS");

    const tokenPublicId = `tok_${createHash("sha256").update(tokenValue).digest("base64url")}`;
    const revokedBearer = await fetch(`${asUrl}/owner/bearers/${tokenPublicId}/revoke`, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: first.cookie,
      },
      method: "POST",
    });
    assert.equal(revokedBearer.status, 204);
    assert.equal(
      getDb().prepare("SELECT revoked FROM tokens WHERE token_id = ?").get<{ revoked: number }>(tokenValue)?.revoked,
      1
    );

    const revokedOthers = await fetch(`${asUrl}/owner/sessions/revoke-others`, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: first.cookie,
      },
      method: "POST",
    });
    assert.equal(revokedOthers.status, 204);
    assert.equal(
      (
        await fetch(`${asUrl}/owner/session`, {
          headers: { Accept: "application/json", Cookie: first.cookie },
        })
      ).status,
      204,
      "revoke-others preserves the current session"
    );
    assert.equal(
      (
        await fetch(`${asUrl}/owner/session`, {
          headers: { Accept: "application/json", Cookie: second.cookie },
        })
      ).status,
      401,
      "the other browser is immediately refused"
    );

    const remaining = await fetchJson(`${asUrl}/owner/sessions`, {
      headers: { Accept: "application/json", Cookie: first.cookie },
    });
    const remainingBody = remaining.body as { sessions: Array<{ id: string }> };
    assert.equal(remainingBody.sessions.length, 1);
    const revokedCurrent = await fetch(`${asUrl}/owner/sessions/${remainingBody.sessions[0]?.id}/revoke`, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: first.cookie,
      },
      method: "POST",
    });
    assert.equal(revokedCurrent.status, 204);
    assert.equal(
      (
        await fetch(`${asUrl}/owner/session`, {
          headers: { Accept: "application/json", Cookie: first.cookie },
        })
      ).status,
      401
    );
  });
});

test("owner-auth: revoke-all ends the current and every other browser session", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const first = await login(asUrl, TEST_PASSWORD);
    const second = await login(asUrl, TEST_PASSWORD);
    assert.ok(first.cookie && second.cookie);

    const revoked = await fetch(`${asUrl}/owner/sessions/revoke-all`, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: first.cookie,
      },
      method: "POST",
    });
    assert.equal(revoked.status, 204);
    assert.equal(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM owner_sessions WHERE subject_id = ? AND revoked_at IS NULL")
        .get<{ count: number }>(OWNER_SUBJECT_ID)?.count,
      0
    );
    assert.equal(
      (
        await fetch(`${asUrl}/owner/session`, {
          headers: { Accept: "application/json", Cookie: first.cookie },
        })
      ).status,
      401,
      "the session making the request is also revoked"
    );
    assert.equal(
      (
        await fetch(`${asUrl}/owner/session`, {
          headers: { Accept: "application/json", Cookie: second.cookie },
        })
      ).status,
      401,
      "every other browser session is revoked"
    );
  });
});

test("owner-auth: app-managed password change keeps this session and ends other sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdpp-owner-password-change-"));
  const dbPath = join(directory, "owner.sqlite");
  const oldPassword = "correct-horse-battery-staple";
  const newPassword = "a-new-password-with-fifteen-plus";
  try {
    initDb(dbPath);
    await setOwnerPassword(createOwnerPasswordVerifierStore(), oldPassword);
    closeDb();
    await withServer(
      {
        dbPath,
      },
      async ({ asUrl }) => {
        const first = await login(asUrl, oldPassword);
        const second = await login(asUrl, oldPassword);
        assert.ok(first.cookie && second.cookie);
        const change = (currentPassword: string, newPassword: string) =>
          fetch(`${asUrl}/owner/password/change`, {
            body: JSON.stringify({ currentPassword, newPassword }),
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              Cookie: first.cookie as string,
            },
            method: "POST",
          });

        const wrongCurrentPassword = await change("wrong current password", newPassword);
        assert.equal(wrongCurrentPassword.status, 401);
        assert.equal(
          ((await wrongCurrentPassword.json()) as { error?: { code?: string; message?: string } }).error?.code,
          "owner_password_invalid"
        );
        assert.equal((await change(oldPassword, "too-short")).status, 400);
        assert.equal((await change(oldPassword, newPassword)).status, 204);
        assert.equal(
          (
            await fetch(`${asUrl}/owner/session`, {
              headers: { Cookie: first.cookie as string },
            })
          ).status,
          204
        );
        assert.equal(
          (
            await fetch(`${asUrl}/owner/session`, {
              headers: { Cookie: second.cookie as string },
            })
          ).status,
          401
        );
        assert.equal((await login(asUrl, oldPassword)).status, 401);
        assert.equal((await login(asUrl, newPassword)).status, 302);
      }
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("owner-device approval is fenced against app-password rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdpp-owner-device-password-race-"));
  const dbPath = join(directory, "owner.sqlite");
  const initialPassword = "initial owner device password";
  const resetPassword = "reset owner device password";
  let releaseApproval: () => void = () => undefined;
  let markApprovalPaused: () => void = () => undefined;
  const approvalPaused = new Promise<void>((resolve) => {
    markApprovalPaused = resolve;
  });
  const approvalResume = new Promise<void>((resolve) => {
    releaseApproval = resolve;
  });
  let pauseNextApproval = true;
  try {
    initDb(dbPath);
    await setOwnerPassword(createOwnerPasswordVerifierStore(), initialPassword);
    closeDb();

    await withServer(
      {
        dbPath,
        ownerDeviceApprovalBeforeDecision: async () => {
          if (!pauseNextApproval) return;
          pauseNextApproval = false;
          markApprovalPaused();
          await approvalResume;
        },
      },
      async ({ asUrl }) => {
        const firstSession = await login(asUrl, initialPassword);
        const firstCookie = firstSession.cookie;
        assert.ok(firstCookie);
        const device = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });
        if (typeof device.user_code !== "string" || typeof device.device_code !== "string") {
          throw new Error("Device authorization did not return its codes.");
        }
        const userCode = device.user_code;
        const deviceCode = device.device_code;
        const csrf = await fetchHostedFormCsrf(
          asUrl,
          `/device?user_code=${encodeURIComponent(userCode)}`,
          firstCookie
        );
        assert.ok(csrf.csrfField);
        const sendApproval = (cookie: string, csrfCookie: string, csrfField: string) =>
          fetch(`${asUrl}/device/approve`, {
            body: new URLSearchParams({ _csrf: csrfField, user_code: userCode }).toString(),
            headers: {
              Accept: "text/html",
              "Content-Type": "application/x-www-form-urlencoded",
              Cookie: `${cookie}; ${csrfCookie}`,
            },
            method: "POST",
            redirect: "manual",
          });

        const inFlightApproval = sendApproval(firstCookie, csrf.csrfCookie ?? "", csrf.csrfField);
        await Promise.race([
          approvalPaused,
          inFlightApproval.then(async (response) => {
            throw new Error(`Approval returned ${response.status} before the test barrier: ${await response.text()}`);
          }),
        ]);

        const passwordStore = createOwnerPasswordVerifierStore();
        const resetVerifier = await createOwnerPasswordVerifier(resetPassword);
        assert.equal(await passwordStore.writeAndRevokeAccess(resetVerifier, OWNER_SUBJECT_ID), true);
        releaseApproval();

        const staleApprovalResponse = await inFlightApproval;
        assert.equal(staleApprovalResponse.status, 409);
        const stillPending = getDb()
          .prepare("SELECT status, token_id FROM owner_device_auth WHERE device_code = ?")
          .get<{ status: string; token_id: string | null }>(deviceCode);
        assert.deepEqual(stillPending, { status: "pending", token_id: null });

        const secondSession = await login(asUrl, resetPassword);
        const secondCookie = secondSession.cookie;
        assert.ok(secondCookie);
        const secondCsrf = await fetchHostedFormCsrf(
          asUrl,
          `/device?user_code=${encodeURIComponent(userCode)}`,
          secondCookie
        );
        assert.ok(secondCsrf.csrfField);
        const completedApproval = await sendApproval(
          secondCookie,
          secondCsrf.csrfCookie ?? "",
          secondCsrf.csrfField
        );
        assert.equal(completedApproval.status, 200);
        const approved = getDb()
          .prepare("SELECT token_id FROM owner_device_auth WHERE device_code = ?")
          .get<{ token_id: string | null }>(deviceCode);
        const tokenId = approved?.token_id;
        assert.ok(tokenId);
        assert.equal((await introspect(tokenId)).active, true);

        const nextVerifier = await createOwnerPasswordVerifier("final owner device password");
        const activeVerifier = await passwordStore.readVersioned();
        if (!activeVerifier) throw new Error("Expected stored verifier after the first reset.");
        assert.equal(
          await passwordStore.writeAndRevokeAccess(
            nextVerifier,
            OWNER_SUBJECT_ID,
            null,
            activeVerifier.revision
          ),
          true
        );
        assert.equal((await introspect(tokenId)).active, false);
      }
    );
  } finally {
    releaseApproval();
    await rm(directory, { force: true, recursive: true });
  }
});

test("owner-auth: env-managed password change is rejected and source remains env", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    assert.ok(cookie);
    const source = await fetch(`${asUrl}/owner/password`, {
      headers: { Accept: "application/json", Cookie: cookie },
    });
    assert.deepEqual(await source.json(), {
      object: "owner_password",
      source: "env",
      minimumLength: 15,
    });
    const response = await fetch(`${asUrl}/owner/password/change`, {
      body: JSON.stringify({
        currentPassword: TEST_PASSWORD,
        newPassword: "another-long-password-here",
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      method: "POST",
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error?: { code?: string } }).error?.code, "owner_password_env_managed");
  });
});

test("owner-auth: desktop sign-in reuses one labeled This computer session row", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const loginDesktop = async () => {
      const response = await fetch(`${asUrl}/owner/login`, {
        body: JSON.stringify({ password: TEST_PASSWORD }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-PDPP-Owner-Session-Label": "This computer",
        },
        method: "POST",
        redirect: "manual",
      });
      assert.equal(response.status, 302);
      assert.match(response.headers.get("set-cookie") ?? "", /^pdpp_owner_session=/u);
      return extractSessionCookie(getRawSetCookieList(response));
    };

    const priorCookie = await loginDesktop();
    const currentCookie = await loginDesktop();
    assert.ok(priorCookie && currentCookie);
    assert.equal(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM owner_sessions WHERE subject_id = ? AND device_key = 'desktop-shell'")
        .get<{ count: number }>(OWNER_SUBJECT_ID)?.count,
      1,
      "repeated shell login updates its device slot instead of adding inventory rows"
    );
    const list = await fetchJson(`${asUrl}/owner/sessions`, {
      headers: { Accept: "application/json", Cookie: currentCookie },
    });
    assert.equal(list.status, 200);
    const sessions = (list.body as { sessions: Array<{ label: string; current: boolean }> }).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.label, "This computer");
    assert.equal(sessions[0]?.current, true);
    assert.equal(
      (
        await fetch(`${asUrl}/owner/session`, {
          headers: { Accept: "application/json", Cookie: priorCookie },
        })
      ).status,
      401
    );
  });
});

test("owner-auth: an SQLite owner session survives an authorization-server restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdpp-owner-session-restart-"));
  const dbPath = join(directory, "pdpp.sqlite");
  let cookie = "";
  try {
    await withServer({ dbPath, ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
      const loginResult = await login(asUrl, TEST_PASSWORD);
      assert.ok(loginResult.cookie);
      cookie = loginResult.cookie;
    });
    await withServer({ dbPath, ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
      const response = await fetch(`${asUrl}/owner/session`, {
        headers: { Accept: "application/json", Cookie: cookie },
      });
      assert.equal(response.status, 204, "the durable hashed session remains valid after a process restart");
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
