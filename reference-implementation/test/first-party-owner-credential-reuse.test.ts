// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * On every app start the desktop starts the reference server, signs in as the
 * owner (`finish_bootstrap` in src-tauri/src/unified.rs), and starts the
 * console. The console mints an owner bearer through the device flow
 * (`apps/console/src/app/(console)/lib/owner-token.ts`, client
 * `pdpp-polyfill-owner-bootstrap`), and the connector runtime mints one for
 * every connector run (`issueRuntimeOwnerToken` in runtime/controller.ts).
 * Nothing reused or revoked the earlier ones, so Settings filled with owner
 * sessions and year-long owner bearers.
 *
 * These tests start the server repeatedly on one data directory, sign in and
 * mint the way the desktop, the console and the runtime do, and count the
 * live owner sessions and bearers.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  approveOwnerDeviceAuthorization,
  initiateOwnerDeviceAuthorization,
  introspect,
  issueOwnerToken,
  seedPreRegisteredClients,
} from "../server/auth.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  CONNECTOR_RUNTIME_OWNER_CLIENT_ID,
  DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS,
  DEMO_PRE_REGISTERED_PUBLIC_CLIENTS,
  defaultPreRegisteredPublicClientsFor,
  PRODUCT_PRE_REGISTERED_PUBLIC_CLIENTS,
} from "../server/reference-local-defaults.ts";
import { getOwnerSessionStore, revokeLeakedFirstPartyOwnerCredentials } from "../server/stores/owner-session-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const TEST_PASSWORD = "placeholder-test-password";
const SUBJECT = "owner_local";
const CONSOLE_CLIENT = "pdpp-polyfill-owner-bootstrap";
const DAY_MS = 24 * 60 * 60 * 1000;

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
  schedulerManager?: { stop?: () => void };
  abortStartupBackfill?: (reason: string) => void;
};

async function stop(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.("test shutdown");
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.all(
    [server.asServer, server.rsServer].map((srv) => new Promise<void>((resolve) => srv.close(() => resolve()))),
  );
  closeDb();
}

async function start(dbPath: string): Promise<{ server: StartedServer; asUrl: string }> {
  const server = (await startServer({
    asPort: 0,
    dbPath,
    ownerAuthPassword: TEST_PASSWORD,
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  return { server, asUrl: `http://localhost:${server.asPort}` };
}

function sessionCookieFrom(setCookie: readonly string[]): string {
  const pair = setCookie.map((header) => header.split(";")[0]).find((p) => p?.startsWith("pdpp_owner_session="));
  assert.ok(pair, "login sets an owner session cookie");
  return pair;
}

/**
 * The desktop's sign-in (`login_reference_server_with_password_and_host` in
 * src-tauri/src/commands/ref_server.rs): a JSON POST with no User-Agent, and
 * the session label only when `label` is given. `fetch` always sends a
 * User-Agent, so this uses node:http.
 */
function desktopSignIn(asUrl: string, label?: string): Promise<string> {
  const body = JSON.stringify({ password: TEST_PASSWORD });
  return new Promise((resolve, reject) => {
    const req = request(
      `${asUrl}/owner/login`,
      {
        headers: {
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Content-Type": "application/json",
          ...(label ? { "X-PDPP-Owner-Session-Label": label } : {}),
        },
        method: "POST",
      },
      (res) => {
        res.resume();
        try {
          resolve(sessionCookieFrom(res.headers["set-cookie"] ?? []));
        } catch (err) {
          reject(err);
        }
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function post(url: string, cookie: string, body: Record<string, unknown>): Promise<Response> {
  const resp = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Cookie: cookie },
    method: "POST",
  });
  assert.equal(resp.ok, true, `${url} -> ${resp.status}`);
  return resp;
}

/** The three POSTs `mintOwnerToken` in the console's owner-token.ts sends. */
async function mintLikeConsole(asUrl: string, cookie: string): Promise<string> {
  const device = (await (
    await post(`${asUrl}/oauth/device_authorization`, cookie, { client_id: CONSOLE_CLIENT })
  ).json()) as { device_code: string; user_code: string };
  // The console checks only the status of the approval, as here.
  await post(`${asUrl}/device/approve`, cookie, { user_code: device.user_code });
  const token = (await (
    await post(`${asUrl}/oauth/token`, cookie, {
      client_id: CONSOLE_CLIENT,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
  ).json()) as { access_token?: unknown };
  assert.equal(typeof token.access_token, "string");
  return token.access_token as string;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function liveBearerLabels(): Promise<string[]> {
  return (await getOwnerSessionStore().listOwnerBearers(SUBJECT, nowSeconds())).map((b) => b.label).sort();
}

async function liveSessionLabels(): Promise<string[]> {
  return (await getOwnerSessionStore().listSessions(SUBJECT, nowSeconds())).map((s) => s.label ?? "").sort();
}

async function isActive(token: string): Promise<boolean> {
  return (await introspect(token)).active === true;
}

async function sessionStatus(asUrl: string, cookie: string): Promise<number> {
  return (await fetch(`${asUrl}/owner/session`, { headers: { Cookie: cookie }, redirect: "manual" })).status;
}

function rowCount(table: "owner_sessions" | "tokens"): number {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>()?.n ?? 0;
}

function registeredClientIds(): string[] {
  return getDb()
    .prepare("SELECT client_id FROM oauth_clients ORDER BY client_id")
    .all<{ client_id: string }>()
    .map((row) => row.client_id);
}

const DEMO_CLIENT_IDS = DEMO_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => client.client_id);

/**
 * Runs with a fresh data directory. `env` is applied for the duration, e.g.
 * `PDPP_MANAGED_DESKTOP_HOST=1`, which the desktop app starts the server with.
 */
function withDataDir(run: (dataDir: string) => Promise<void>, env: Record<string, string> = {}): () => Promise<void> {
  return async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-owner-credential-reuse-"));
    const applied = { ...env, PDPP_DATA_DIR: dataDir };
    const previous = Object.fromEntries(Object.keys(applied).map((key) => [key, process.env[key]]));
    Object.assign(process.env, applied);
    try {
      await run(dataDir);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dataDir, { force: true, recursive: true });
    }
  };
}

test("demo clients are pre-registered only outside product builds", () => {
  const ids = (env: Record<string, string>) => defaultPreRegisteredPublicClientsFor(env).map((c) => c.client_id);
  const product = PRODUCT_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => client.client_id);
  assert.deepEqual(ids({}), [...DEMO_CLIENT_IDS, ...product], "dev and tests keep the demo clients");
  assert.deepEqual(ids({ NODE_ENV: "production" }), product, "the Docker images drop them");
  assert.deepEqual(ids({ PDPP_MANAGED_DESKTOP_HOST: "1" }), product, "the desktop app drops them");
  assert.deepEqual(
    ids({ NODE_ENV: "production", PDPP_ENABLE_DEMO_CLIENTS: "1" }),
    [...DEMO_CLIENT_IDS, ...product],
    "a reference demo deployment can opt back in",
  );
  assert.deepEqual(DEMO_CLIENT_IDS, ["longview", "longview_planning_v1", "cli_longview", "concert_recommendation_app"]);
});

test(
  "a dev server registers the demo clients",
  withDataDir(async (dataDir) => {
    const { server } = await start(join(dataDir, "pdpp.sqlite"));
    try {
      const registered = registeredClientIds();
      for (const id of [...DEMO_CLIENT_IDS, CONSOLE_CLIENT, CONNECTOR_RUNTIME_OWNER_CLIENT_ID]) {
        assert.ok(registered.includes(id), `${id} is registered`);
      }
    } finally {
      await stop(server);
    }
  }),
);

test(
  "desktop app starts and connector runs add no owner session or bearer rows after the first start",
  withDataDir(
    async (dataDir) => {
      const dbPath = join(dataDir, "pdpp.sqlite");
      const starts = 3;
      const runsPerStart = 2;
      const desktopCookies: string[] = [];
      const consoleTokens: string[] = [];
      const runtimeTokens: string[] = [];
      let rowsAfterFirstStart: { sessions: number; tokens: number } | null = null;
      for (let i = 0; i < starts; i++) {
        const { server, asUrl } = await start(dbPath);
        try {
          const registered = registeredClientIds();
          for (const id of DEMO_CLIENT_IDS) {
            assert.equal(registered.includes(id), false, `the desktop server does not register ${id}`);
          }
          const cookie = await desktopSignIn(asUrl, "This computer");
          desktopCookies.push(cookie);
          consoleTokens.push(await mintLikeConsole(asUrl, cookie));
          for (let run = 0; run < runsPerStart; run++) {
            runtimeTokens.push(await server.controller.issueRuntimeOwnerToken(SUBJECT));
          }
          assert.equal(await isActive(consoleTokens.at(-1) as string), true, "the console bearer works");
          assert.equal(await isActive(runtimeTokens.at(-1) as string), true, "the runtime bearer works");
          assert.equal(await sessionStatus(asUrl, cookie), 204, "this start's desktop session works");
          for (const earlier of desktopCookies.slice(0, -1)) {
            assert.equal(await sessionStatus(asUrl, earlier), 401, "an earlier start's desktop session is gone");
          }
          assert.deepEqual(await liveSessionLabels(), ["This computer"]);
          assert.deepEqual(
            await liveBearerLabels(),
            ["PDPP Connector Runtime", "PDPP Polyfill Owner Bootstrap"],
            `after ${i + 1} starts x (1 console mint + ${runsPerStart} runtime mints)`,
          );
          const rows = { sessions: rowCount("owner_sessions"), tokens: rowCount("tokens") };
          rowsAfterFirstStart ??= rows;
          assert.deepEqual(rows, rowsAfterFirstStart, `start ${i + 1} adds no session or token rows`);
        } finally {
          await stop(server);
        }
      }
      assert.deepEqual(rowsAfterFirstStart, { sessions: 1, tokens: 2 });
      assert.equal(new Set(consoleTokens).size, 1, "the console gets the same bearer on every start");
      assert.equal(new Set(runtimeTokens).size, 1, "every connector run gets the same bearer");
    },
    { PDPP_MANAGED_DESKTOP_HOST: "1" },
  ),
);

function insertDeviceApprovedToken(clientId: string, tokenId: string, approvedAfterMs: number): void {
  const approvedAt = new Date().toISOString();
  const requestedAt = new Date(Date.now() - approvedAfterMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO owner_device_auth(device_code, user_code, client_id, status, subject_id, token_id, created_at, expires_at, approved_at)
       VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
    )
    .run(`dc_${tokenId}`, "HUMAN1", clientId, SUBJECT, tokenId, requestedAt, approvedAt, approvedAt);
}

test(
  "startup revokes the owner sessions and bearers the leak left behind and keeps the ones in use",
  withDataDir(async (dataDir) => {
    const dbPath = join(dataDir, "pdpp.sqlite");
    const first = await start(dbPath);
    const keptBearers: string[] = [];
    const leakedBearers: string[] = [];
    const oldDesktopCookies: string[] = [];
    let browserCookie: string;
    try {
      // Leftovers of the leak, as the old code wrote them.
      // Desktop sign-ins without a label, one per app start.
      for (let i = 0; i < 3; i++) {
        // Each earlier app start happened a while before the next one.
        getDb().prepare("UPDATE owner_sessions SET created_at = created_at - 3600 WHERE user_agent IS NULL").run();
        oldDesktopCookies.push(await desktopSignIn(first.asUrl));
      }
      // A person signed in from a browser. Not a leak.
      browserCookie = sessionCookieFrom(
        (
          await fetch(`${first.asUrl}/owner/login`, {
            body: JSON.stringify({ password: TEST_PASSWORD }),
            headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Firefox/140.0" },
            method: "POST",
            redirect: "manual",
          })
        ).headers.getSetCookie(),
      );
      // Console bearers from earlier starts; an earlier start expires earlier.
      for (let i = 0; i < 4; i++) {
        const leaked = await issueOwnerToken(SUBJECT, { clientId: CONSOLE_CLIENT });
        getDb()
          .prepare("UPDATE tokens SET expires_at = ? WHERE token_id = ?")
          .run(new Date(Date.now() + (300 + i) * DAY_MS).toISOString(), leaked);
        leakedBearers.push(leaked);
      }
      // Connector-runtime bearers under `cli_longview`, which the runtime
      // approved in-process right after it requested them.
      for (let i = 0; i < 5; i++) {
        const device = await initiateOwnerDeviceAuthorization("cli_longview");
        leakedBearers.push((await approveOwnerDeviceAuthorization(device.user_code, SUBJECT)).access_token as string);
      }
      keptBearers.push(await issueOwnerToken(SUBJECT, { clientId: CONSOLE_CLIENT }));
      // A person signed a real Longview CLI in: the approval came a minute
      // after the request. Not a leak.
      const humanCli = `tok_human_cli_${"x".repeat(20)}`;
      getDb()
        .prepare(
          "INSERT INTO tokens(token_id, subject_id, client_id, token_kind, expires_at) VALUES (?, ?, 'cli_longview', 'owner', ?)",
        )
        .run(humanCli, SUBJECT, new Date(Date.now() + 100 * DAY_MS).toISOString());
      insertDeviceApprovedToken("cli_longview", humanCli, 60_000);
      keptBearers.push(humanCli);
      // Owner bearers of other clients are not touched.
      keptBearers.push(await issueOwnerToken(SUBJECT, { clientId: "pdpp_cli" }));
      assert.equal((await liveBearerLabels()).length, 12, "the bearer leak is in place before the restart");
      assert.equal((await liveSessionLabels()).length, 4, "the session leak is in place before the restart");
    } finally {
      await stop(first.server);
    }

    for (let restart = 1; restart <= 2; restart++) {
      const { server, asUrl } = await start(dbPath);
      try {
        assert.deepEqual(
          await liveBearerLabels(),
          ["Longview CLI", "PDPP CLI", "PDPP Polyfill Owner Bootstrap"],
          `restart ${restart} leaves only the kept bearers`,
        );
        assert.deepEqual(
          await liveSessionLabels(),
          ["Firefox", "Unknown browser"],
          `restart ${restart} keeps the browser session and the newest old desktop session`,
        );
        for (const token of keptBearers) {
          assert.equal(await isActive(token), true, `kept bearer ${keptBearers.indexOf(token)} still works`);
        }
        for (const token of leakedBearers) {
          assert.equal(await isActive(token), false, `leaked bearer ${leakedBearers.indexOf(token)} is revoked`);
        }
        assert.equal(await sessionStatus(asUrl, browserCookie), 204, "the browser session still works");
        assert.equal(await sessionStatus(asUrl, oldDesktopCookies.at(-1) as string), 204);
        for (const cookie of oldDesktopCookies.slice(0, -1)) {
          assert.equal(await sessionStatus(asUrl, cookie), 401, "an older desktop session is revoked");
        }
        assert.equal(
          await mintLikeConsole(asUrl, browserCookie),
          keptBearers[0],
          "the console reuses the bearer the prune kept",
        );
      } finally {
        await stop(server);
      }
    }
  }),
);

async function approveOwnerDevice(clientId: string): Promise<string> {
  const device = await initiateOwnerDeviceAuthorization(clientId);
  return (await approveOwnerDeviceAuthorization(device.user_code, SUBJECT)).access_token as string;
}

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

if (POSTGRES_URL) {
  test("Postgres: approvals reuse the live first-party bearer and the prune keeps the newest", async () => {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await seedPreRegisteredClients(DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => ({ ...client })));
      const leakedConsole: string[] = [];
      for (let i = 0; i < 3; i++) {
        const token = await issueOwnerToken(SUBJECT, { clientId: CONSOLE_CLIENT });
        await postgresQuery("UPDATE tokens SET expires_at = $1 WHERE token_id = $2", [
          new Date(Date.now() + (300 + i) * DAY_MS).toISOString(),
          token,
        ]);
        leakedConsole.push(token);
      }
      const leakedRuntime = [await approveOwnerDevice("cli_longview"), await approveOwnerDevice("cli_longview")];
      const keptConsole = await issueOwnerToken(SUBJECT, { clientId: CONSOLE_CLIENT });
      const humanCli = `tok_human_cli_pg_${"y".repeat(20)}`;
      await postgresQuery(
        "INSERT INTO tokens(token_id, subject_id, client_id, token_kind, expires_at) VALUES ($1, $2, 'cli_longview', 'owner', $3)",
        [humanCli, SUBJECT, new Date(Date.now() + 100 * DAY_MS).toISOString()],
      );
      await postgresQuery(
        `INSERT INTO owner_device_auth(device_code, user_code, client_id, status, subject_id, token_id, created_at, expires_at, approved_at)
         VALUES ($1, 'HUMAN1', 'cli_longview', 'approved', $2, $3, $4, $5, $5)`,
        [`dc_${humanCli}`, SUBJECT, humanCli, new Date(Date.now() - 60_000).toISOString(), new Date().toISOString()],
      );
      const now = nowSeconds();
      const session = (id: string, createdAt: number, label: string, userAgent: string | null) =>
        postgresQuery(
          `INSERT INTO owner_sessions(id_hash, session_id, subject_id, device_key, label, user_agent, ip_address, created_at, expires_at, last_seen_at, revoked_at)
           VALUES ($1, $1, $2, NULL, $3, $4, NULL, $5, $6, $5, NULL)`,
          [id, SUBJECT, label, userAgent, createdAt, createdAt + 7 * 24 * 60 * 60],
        );
      await session("desktop_old_0001", now - 300, "Unknown browser", null);
      await session("desktop_old_0002", now - 200, "Unknown browser", null);
      await session("desktop_new_0003", now - 100, "Unknown browser", null);
      await session("firefox_0000_004", now - 400, "Firefox", "Firefox/140.0");

      assert.deepEqual(await revokeLeakedFirstPartyOwnerCredentials(now), {
        bearers: leakedConsole.length + leakedRuntime.length,
        sessions: 2,
      });
      assert.deepEqual(
        await revokeLeakedFirstPartyOwnerCredentials(now),
        { bearers: 0, sessions: 0 },
        "a second prune revokes nothing",
      );
      for (const token of [...leakedConsole, ...leakedRuntime]) {
        assert.equal(await isActive(token), false, "a leaked bearer is revoked");
      }
      for (const token of [keptConsole, humanCli]) {
        assert.equal(await isActive(token), true, "a kept bearer still works");
      }
      const liveSessions = await postgresQuery<{ id_hash: string }>(
        "SELECT id_hash FROM owner_sessions WHERE revoked_at IS NULL ORDER BY id_hash",
      );
      assert.deepEqual(
        liveSessions.rows.map((row) => row.id_hash),
        ["desktop_new_0003", "firefox_0000_004"],
      );

      assert.equal(await approveOwnerDevice(CONSOLE_CLIENT), keptConsole, "the console reuses the kept bearer");
      const runtime = await approveOwnerDevice(CONNECTOR_RUNTIME_OWNER_CLIENT_ID);
      assert.equal(await approveOwnerDevice(CONNECTOR_RUNTIME_OWNER_CLIENT_ID), runtime, "runs reuse one bearer");
      assert.notEqual(await approveOwnerDevice("cli_longview"), humanCli, "other clients still get a new bearer");
    } finally {
      await closePostgresStorage();
    }
  });
} else {
  test(
    "Postgres: approvals reuse the live first-party bearer and the prune keeps the newest (skipped: PDPP_TEST_POSTGRES_URL unset)",
    { skip: true },
    () => undefined,
  );
}
