const TOP_LEVEL_REGEX_1 = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted-exposure hardening — end-to-end (security audit S-1 + S-2, lane A1).
 *
 * Proves at the live HTTP boundary that:
 *   S-1  hosted posture WITHOUT a password boots with owner access locked.
 *   S-2  with a password, an unauthenticated `POST /connectors` (manifest
 *        upsert — a one-request grant-wipe DoS) returns 401; the authenticated
 *        owner can still register.
 *   And that the local-dev posture (no signals) preserves the open
 *        password-optional `POST /connectors` the dev/test harness relies on.
 *
 * The hosted posture here is driven by the same declared-origin contract that
 * production startup reads from the environment.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const SPOTIFY_MANIFEST = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")) as {
  connector_id: string;
};

const TEST_PASSWORD = "hosted-exposure-test-password";

interface TestHttpServer {
  close: (callback: () => void) => void;
  closeAllConnections?: () => void;
}

interface TestServerHandle {
  abortStartupBackfill?: (reason: string) => void;
  asPort: number;
  asServer: TestHttpServer;
  controller?: {
    drainActiveRuns?: (timeoutMs: number) => Promise<unknown>;
  };
  rsPort: number;
  rsServer: TestHttpServer;
  schedulerManager?: {
    stop?: () => void;
  };
}

async function closeServer(server: TestServerHandle | null): Promise<void> {
  if (!server) {
    return;
  }
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.("test shutdown");
  try {
    server.asServer.closeAllConnections?.();
  } catch {
    // best-effort
  }
  try {
    server.rsServer.closeAllConnections?.();
  } catch {
    // best-effort
  }
  const closeWithTimeout = (srv: TestHttpServer | undefined) =>
    new Promise<void>((resolve) => {
      if (!srv) {
        resolve();
        return;
      }
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
    server.controller?.drainActiveRuns
      ? server.controller.drainActiveRuns(1000).catch(() => undefined)
      : Promise.resolve(),
  ]);
  closeDb();
}

interface WithServerOptions {
  ownerAuthPassword?: string;
}

async function withServer(
  opts: WithServerOptions,
  fn: (ctx: { asUrl: string; server: TestServerHandle }) => Promise<void>
): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ignoreAmbientPublicUrls: false,
    quiet: true,
    rsPort: 0,
    ...opts,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl, server });
  } finally {
    await closeServer(server);
  }
}

// Minimal login helper (mirrors owner-auth.test.js) to obtain a session cookie.
function getSetCookies(resp: Response): string[] {
  const headersWithGetSetCookie = resp.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithGetSetCookie.getSetCookie === "function") {
    return headersWithGetSetCookie.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}
function findPair(list: string[], name: string): string | null {
  for (const header of list) {
    const [first] = header.split(";");
    if (first?.startsWith(`${name}=`)) {
      return first;
    }
  }
  return null;
}
function extractCsrfField(html: string): string | null {
  const m = html.match(TOP_LEVEL_REGEX_1);
  return m ? (m[1] ?? null) : null;
}
async function login(asUrl: string, password: string): Promise<string | null> {
  const getResp = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findPair(getSetCookies(getResp), "pdpp_owner_csrf");
  const csrfField = extractCsrfField(await getResp.text());
  const postResp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField || "", password, return_to: "/" }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie || "",
    },
    method: "POST",
    redirect: "manual",
  });
  return findPair(getSetCookies(postResp), "pdpp_owner_session");
}

async function requestWithHeaders(
  url: string,
  headers: Record<string, string>
): Promise<{ body: string; status: number }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers,
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        port: parsed.port,
      },
      response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => {
          body += chunk;
        });
        response.on("end", () => resolve({ body, status: response.statusCode ?? 0 }));
      }
    );
    request.on("error", reject);
    request.end();
  });
}

// Run a block with the declared hosted contract in the environment, restoring
// it after. The loopback bind keeps the test listener local while the public
// origin exercises hosted owner-auth and request-boundary behavior.
async function withHostedEnv(fn: () => Promise<void>): Promise<void> {
  const previous = {
    bindHost: process.env.PDPP_BIND_HOST,
    ownerPassword: process.env.PDPP_OWNER_PASSWORD,
    origin: process.env.PDPP_REFERENCE_ORIGIN,
    trustedHosts: process.env.PDPP_TRUSTED_HOSTS,
  };
  process.env.PDPP_BIND_HOST = "127.0.0.1";
  delete process.env.PDPP_OWNER_PASSWORD;
  process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example";
  process.env.PDPP_TRUSTED_HOSTS = "localhost,127.0.0.1,::1";
  try {
    await fn();
  } finally {
    for (const [name, value] of [
      ["PDPP_BIND_HOST", previous.bindHost],
      ["PDPP_OWNER_PASSWORD", previous.ownerPassword],
      ["PDPP_REFERENCE_ORIGIN", previous.origin],
      ["PDPP_TRUSTED_HOSTS", previous.trustedHosts],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// ── S-1: hosted + no password → boot locked ─────────────────────────────────
test("S-1: declared hosted origin without a password boots locked", async () => {
  await withHostedEnv(async () => {
    await withServer({}, async ({ asUrl }) => {
      assert.equal((await fetch(`${asUrl}/setup`)).status, 200, "first-run claim page is available");
      assert.equal((await fetch(`${asUrl}/owner/session`)).status, 401, "owner routes stay locked before claim");
        });
  });
});

test("S-1: an empty configured password still reaches setup", async () => {
  await withHostedEnv(async () => {
    await withServer({ ownerAuthPassword: "" }, async ({ asUrl }) => {
      assert.equal((await fetch(`${asUrl}/setup`)).status, 200, "empty env value is treated as unset");
      assert.equal((await fetch(`${asUrl}/owner/session`)).status, 401, "owner routes stay locked before claim");
    });
  });
});

test("S-1: an explicit configured password skips setup", async () => {
  await withHostedEnv(async () => {
    await withServer({ ownerAuthPassword: "explicit-operator-password" }, async ({ asUrl }) => {
      assert.equal((await fetch(`${asUrl}/setup`)).status, 404, "configured env value skips the wizard");
      assert.equal((await fetch(`${asUrl}/owner/login`)).status, 200, "owner login remains available");
    });
  });
});

test("S-1: owner-auth-required loopback posture reaches setup and locks owner routes", async () => {
  const previous = {
    ownerAuthRequired: process.env.PDPP_OWNER_AUTH_REQUIRED,
    origin: process.env.PDPP_REFERENCE_ORIGIN,
    trustedHosts: process.env.PDPP_TRUSTED_HOSTS,
  };
  process.env.PDPP_OWNER_AUTH_REQUIRED = "1";
  process.env.PDPP_REFERENCE_ORIGIN = "http://localhost:3200";
  process.env.PDPP_TRUSTED_HOSTS = "localhost,127.0.0.1,::1";
  try {
    await withServer({}, async ({ asUrl }) => {
      assert.equal((await fetch(`${asUrl}/setup`)).status, 200, "first-run claim page is available");
      assert.equal((await fetch(`${asUrl}/owner/session`)).status, 401, "owner routes stay locked before claim");
    });
  } finally {
    for (const [name, value] of [
      ["PDPP_OWNER_AUTH_REQUIRED", previous.ownerAuthRequired],
      ["PDPP_REFERENCE_ORIGIN", previous.origin],
      ["PDPP_TRUSTED_HOSTS", previous.trustedHosts],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ── S-1: hosted + password → boots normally ──────────────────────────────────
test("S-1: hosted posture WITH a password boots and serves", async () => {
  await withHostedEnv(async () => {
    await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
      const meta = await fetch(`${asUrl}/.well-known/oauth-authorization-server`);
      assert.equal(meta.status, 200);
    });
  });
});

// ── S-2: hosted POST /connectors requires an owner session ───────────────────
test("S-2: hosted posture gates POST /connectors behind owner session; GET detail stays open", async () => {
  await withHostedEnv(async () => {
    await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
      // Unauthenticated upsert is rejected — a bumped manifest version cannot
      // wipe grants without an owner session.
      const unauth = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(SPOTIFY_MANIFEST),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(unauth.status, 401, "unauthenticated POST /connectors is rejected in hosted mode");
      const unauthBody = (await unauth.json()) as { error: { code: string } };
      assert.equal(unauthBody.error.code, "owner_session_required");

      // Authenticated owner can still register.
      const cookie = await login(asUrl, TEST_PASSWORD);
      assert.ok(cookie, "owner login issued a session cookie");
      const authed = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(SPOTIFY_MANIFEST),
        headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie ?? "" },
        method: "POST",
      });
      assert.equal(authed.status, 201, "authenticated owner can register a connector manifest");

      // GET /connectors/:id (manifest read) remains unauthenticated — it carries
      // no user data and the client-side connect flow needs it.
      const detail = await fetch(`${asUrl}/connectors/${encodeURIComponent(SPOTIFY_MANIFEST.connector_id)}`, {
        headers: { Accept: "application/json" },
      });
      assert.equal(detail.status, 200, "manifest read stays open");
    });
  });
});

test("R3/R4: hosted request boundary rejects mismatched Host and MCP Origin", async () => {
  await withHostedEnv(async () => {
    await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl, server }) => {
      const badHost = await requestWithHeaders(`${asUrl}/.well-known/oauth-authorization-server`, {
        Host: "attacker.example",
      });
      assert.equal(badHost.status, 400);
      assert.doesNotMatch(badHost.body, /attacker\.example/);

      const badOrigin = await fetch(`http://localhost:${server.rsPort}/mcp`, {
        headers: {
          Host: "localhost",
          Origin: "https://attacker.example",
        },
      });
      assert.equal(badOrigin.status, 403);
    });
  });
});

// ── local-dev: open POST /connectors preserved ───────────────────────────────
test("local-dev posture leaves POST /connectors open (dev/test harness self-registers)", async () => {
  await withServer({}, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(SPOTIFY_MANIFEST),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(resp.status, 201, "local-dev register stays frictionless");
  });
});
