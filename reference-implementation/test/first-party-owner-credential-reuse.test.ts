// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * On every app start the desktop starts the reference server, signs in as the
 * owner (`finish_bootstrap` in src-tauri/src/unified.rs), and starts the
 * console. The console mints an owner bearer through the device flow
 * (`apps/console/src/app/(console)/lib/owner-token.ts`, client
 * `dataconnect-console`), and the connector runtime mints one for every
 * connector run (`issueRuntimeOwnerToken` in runtime/controller.ts). Earlier
 * versions minted these as `pdpp-polyfill-owner-bootstrap` and the demo
 * client `cli_longview`, and reused or revoked nothing, so Settings filled
 * with owner sessions and year-long owner bearers.
 *
 * These tests start the server repeatedly on one data directory, sign in and
 * mint the way the desktop, the console and the runtime do, and count the
 * live owner sessions and bearers. They also seed what earlier versions left
 * and check that startup retires it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import pino from "pino";
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
import { DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS } from "../server/reference-local-defaults.ts";
import { getOwnerSessionStore, retireFormerPreRegisteredClients } from "../server/stores/owner-session-store.ts";
import { DEMO_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const TEST_PASSWORD = "placeholder-test-password";
const SUBJECT = "owner_local";
const CONSOLE_CLIENT = "dataconnect-console";
const RUNTIME_CLIENT = "dataconnect-connector-runtime";
/** The clients earlier versions pre-registered and this one retires. */
const OLD_CONSOLE_CLIENT = "pdpp-polyfill-owner-bootstrap";
const DEMO_CLIENT_IDS = DEMO_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => client.client_id);
const OLD_CLIENT_IDS = [OLD_CONSOLE_CLIENT, ...DEMO_CLIENT_IDS];

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
    [server.asServer, server.rsServer].map((srv) => new Promise<void>((resolve) => srv.close(() => resolve())))
  );
  closeDb();
}

interface StartLog {
  msg: string;
  owner_sessions_revoked?: number;
  retired_clients?: Record<
    string,
    {
      bearers: number;
      deregistered: boolean;
      deviceRequests: number;
      refreshTokens: number;
    }
  >;
}

/** Starts the server with its default clients and keeps its warnings. */
async function start(dbPath: string): Promise<{ server: StartedServer; asUrl: string; warnings: StartLog[] }> {
  const warnings: StartLog[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) warnings.push(JSON.parse(line) as StartLog);
      done();
    },
  });
  const server = (await startServer({
    asPort: 0,
    dbPath,
    logger: pino({ level: "warn" }, sink),
    ownerAuthPassword: TEST_PASSWORD,
    rsPort: 0,
  })) as StartedServer;
  return { server, asUrl: `http://localhost:${server.asPort}`, warnings };
}

function retirementLog(warnings: readonly StartLog[]): StartLog | undefined {
  return warnings.find((entry) => entry.retired_clients !== undefined);
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
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function browserSignIn(asUrl: string): Promise<string> {
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: JSON.stringify({ password: TEST_PASSWORD }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Firefox/140.0",
    },
    method: "POST",
    redirect: "manual",
  });
  return sessionCookieFrom(resp.headers.getSetCookie());
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
    await post(`${asUrl}/oauth/device_authorization`, cookie, {
      client_id: CONSOLE_CLIENT,
    })
  ).json()) as { device_code: string; user_code: string };
  // The console checks only the status of the approval, as here.
  await post(`${asUrl}/device/approve`, cookie, {
    user_code: device.user_code,
  });
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
  return (
    await fetch(`${asUrl}/owner/session`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    })
  ).status;
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

/** Every credential row's revocation state, to show a start changed none. */
function credentialState(): unknown {
  const db = getDb();
  return {
    clients: registeredClientIds(),
    deviceRequests: db.prepare("SELECT device_code, status FROM owner_device_auth ORDER BY device_code").all(),
    refreshTokens: db.prepare("SELECT refresh_token_hash, status FROM oauth_refresh_tokens ORDER BY 1").all(),
    sessions: db.prepare("SELECT id_hash, revoked_at FROM owner_sessions ORDER BY id_hash").all(),
    tokens: db.prepare("SELECT token_id, revoked FROM tokens ORDER BY token_id").all(),
  };
}

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

const PRODUCT_CLIENT_IDS = ["dataconnect-connector-runtime", "dataconnect-console", "pdpp-web-dashboard", "pdpp_cli"];

for (const [mode, env] of [
  ["a dev server", {}],
  ["the desktop app", { PDPP_MANAGED_DESKTOP_HOST: "1" }],
  ["a production build", { NODE_ENV: "production" }],
] as const) {
  test(
    `${mode} registers only the product clients`,
    withDataDir(async (dataDir) => {
      const { server } = await start(join(dataDir, "pdpp.sqlite"));
      try {
        assert.deepEqual(registeredClientIds(), PRODUCT_CLIENT_IDS);
      } finally {
        await stop(server);
      }
    }, env)
  );
}

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
            ["DataConnect connector runtime", "DataConnect console"],
            `after ${i + 1} starts x (1 console mint + ${runsPerStart} runtime mints)`
          );
          assert.deepEqual(
            getDb().prepare("SELECT DISTINCT client_id FROM tokens ORDER BY client_id").all(),
            [{ client_id: RUNTIME_CLIENT }, { client_id: CONSOLE_CLIENT }],
            "the bearers carry the product client ids"
          );
          const rows = {
            sessions: rowCount("owner_sessions"),
            tokens: rowCount("tokens"),
          };
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
    { PDPP_MANAGED_DESKTOP_HOST: "1" }
  )
);

/** What earlier versions left, written the way they wrote it. */
interface OldInstall {
  /** Owner bearers under every old client id, by client id. */
  oldBearers: Record<string, string[]>;
  /** Credentials no retirement rule covers. */
  keptBearer: string;
  browserCookie: string;
  /** Unlabelled desktop sign-ins, oldest first. */
  oldDesktopCookies: string[];
  pendingDeviceCode: string;
  refreshTokenHash: string;
}

async function seedOldInstall(asUrl: string): Promise<OldInstall> {
  // Earlier versions pre-registered these at startup.
  await seedPreRegisteredClients([
    {
      client_id: OLD_CONSOLE_CLIENT,
      metadata: {
        client_name: "PDPP Polyfill Owner Bootstrap",
        token_endpoint_auth_method: "none",
      },
    },
    ...DEMO_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => ({
      ...client,
      metadata: { ...client.metadata },
    })),
  ]);
  const oldDesktopCookies: string[] = [];
  for (let i = 0; i < 3; i++) {
    // Each earlier app start happened a while before the next one.
    getDb().prepare("UPDATE owner_sessions SET created_at = created_at - 3600 WHERE user_agent IS NULL").run();
    oldDesktopCookies.push(await desktopSignIn(asUrl));
  }
  const browserCookie = await browserSignIn(asUrl);
  const oldBearers: Record<string, string[]> = {};
  for (const clientId of OLD_CLIENT_IDS) {
    oldBearers[clientId] = [await issueOwnerToken(SUBJECT, { clientId }), await issueOwnerToken(SUBJECT, { clientId })];
  }
  // The old connector runtime approved its own `cli_longview` device requests.
  for (let i = 0; i < 2; i++) {
    const device = await initiateOwnerDeviceAuthorization("cli_longview");
    oldBearers.cli_longview?.push(
      (await approveOwnerDeviceAuthorization(device.user_code, SUBJECT)).access_token as string
    );
  }
  const pending = await initiateOwnerDeviceAuthorization("cli_longview");
  // The demo app `longview` holds an access token and its refresh token.
  const refreshTokenHash = "rth_old_longview_0001";
  getDb()
    .prepare(
      `INSERT INTO tokens(token_id, subject_id, client_id, token_kind, refresh_family_id, expires_at)
       VALUES ('tok_old_longview_access', ?, 'longview', 'client', 'fam_old_longview', ?)`
    )
    .run(SUBJECT, new Date(Date.now() + 3_600_000).toISOString());
  getDb()
    .prepare(
      `INSERT INTO oauth_refresh_tokens(refresh_token_hash, family_id, generation, client_id, subject_id, status, created_at)
       VALUES (?, 'fam_old_longview', 1, 'longview', ?, 'active', ?)`
    )
    .run(refreshTokenHash, SUBJECT, new Date().toISOString());
  // A person granted the demo app `concert_recommendation_app` access, so its
  // client row stays for the grant to name.
  getDb()
    .prepare(
      `INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, status, issued_at)
       VALUES ('grt_old_concert', ?, 'concert_recommendation_app', '{}', 'continuous', 'active', ?)`
    )
    .run(SUBJECT, new Date().toISOString());
  return {
    browserCookie,
    keptBearer: await issueOwnerToken(SUBJECT, { clientId: "pdpp_cli" }),
    oldBearers,
    oldDesktopCookies,
    pendingDeviceCode: pending.device_code as string,
    refreshTokenHash,
  };
}

test(
  "startup revokes every credential of the old client ids and the old desktop sessions, once",
  withDataDir(async (dataDir) => {
    const dbPath = join(dataDir, "pdpp.sqlite");
    const first = await start(dbPath);
    let old: OldInstall;
    try {
      old = await seedOldInstall(first.asUrl);
      assert.equal((await liveBearerLabels()).length, 2 * OLD_CLIENT_IDS.length + 2 + 1, "the old bearers are live");
      assert.equal((await liveSessionLabels()).length, 4, "the old sessions are live");
    } finally {
      await stop(first.server);
    }

    const { server, asUrl, warnings } = await start(dbPath);
    let afterUpgrade: unknown;
    try {
      assert.deepEqual(await liveBearerLabels(), ["PDPP CLI"], "only the pdpp_cli bearer survives");
      for (const [clientId, tokens] of Object.entries(old.oldBearers)) {
        for (const token of tokens) assert.equal(await isActive(token), false, `a ${clientId} bearer is revoked`);
      }
      assert.equal(await isActive(old.keptBearer), true, "the pdpp_cli bearer still works");
      assert.deepEqual(
        await liveSessionLabels(),
        ["Firefox", "Unknown browser"],
        "the browser session and the newest old desktop session stay"
      );
      assert.equal(await sessionStatus(asUrl, old.browserCookie), 204);
      assert.equal(await sessionStatus(asUrl, old.oldDesktopCookies.at(-1) as string), 204);
      for (const cookie of old.oldDesktopCookies.slice(0, -1)) {
        assert.equal(await sessionStatus(asUrl, cookie), 401, "an older desktop session is revoked");
      }
      assert.equal(
        getDb()
          .prepare("SELECT status FROM owner_device_auth WHERE device_code = ?")
          .get<{ status: string }>(old.pendingDeviceCode)?.status,
        "expired"
      );
      assert.equal(
        getDb()
          .prepare("SELECT revoked FROM tokens WHERE token_id = 'tok_old_longview_access'")
          .get<{ revoked: number }>()?.revoked,
        1,
        "the demo app's access token is revoked"
      );
      assert.equal(
        getDb()
          .prepare("SELECT status FROM oauth_refresh_tokens WHERE refresh_token_hash = ?")
          .get<{ status: string }>(old.refreshTokenHash)?.status,
        "revoked"
      );
      assert.deepEqual(
        registeredClientIds(),
        ["concert_recommendation_app", ...PRODUCT_CLIENT_IDS].sort(),
        "the old clients are deregistered except the one an active grant names"
      );
      const log = retirementLog(warnings);
      assert.deepEqual(log?.retired_clients, {
        cli_longview: {
          bearers: 4,
          deregistered: true,
          deviceRequests: 1,
          refreshTokens: 0,
        },
        concert_recommendation_app: {
          bearers: 2,
          deregistered: false,
          deviceRequests: 0,
          refreshTokens: 0,
        },
        longview: {
          bearers: 3,
          deregistered: true,
          deviceRequests: 0,
          refreshTokens: 1,
        },
        longview_planning_v1: {
          bearers: 2,
          deregistered: true,
          deviceRequests: 0,
          refreshTokens: 0,
        },
        "pdpp-polyfill-owner-bootstrap": {
          bearers: 2,
          deregistered: true,
          deviceRequests: 0,
          refreshTokens: 0,
        },
      });
      assert.equal(log?.owner_sessions_revoked, 2);
      assert.doesNotMatch(JSON.stringify(warnings), /tok_|pdpp_owner_session=/u, "the log holds no credential");
      afterUpgrade = credentialState();
    } finally {
      await stop(server);
    }

    const again = await start(dbPath);
    try {
      assert.equal(retirementLog(again.warnings), undefined, "a second start retires nothing");
      assert.deepEqual(credentialState(), afterUpgrade, "a second start revokes and deletes nothing");
    } finally {
      await stop(again.server);
    }
  })
);

test(
  "a server that registers a retired client itself keeps that client's credentials",
  withDataDir(async (dataDir) => {
    const dbPath = join(dataDir, "pdpp.sqlite");
    const clients = [...DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS, ...DEMO_PRE_REGISTERED_PUBLIC_CLIENTS].map((client) => ({
      ...client,
      metadata: { ...client.metadata },
    }));
    const startWith = async () =>
      (await startServer({
        asPort: 0,
        dbPath,
        ownerAuthPassword: TEST_PASSWORD,
        preRegisteredPublicClients: clients,
        quiet: true,
        rsPort: 0,
      })) as StartedServer;
    const first = await startWith();
    let token: string;
    try {
      token = await issueOwnerToken(SUBJECT, { clientId: "cli_longview" });
    } finally {
      await stop(first);
    }
    const second = await startWith();
    try {
      assert.equal(await isActive(token), true);
      assert.ok(registeredClientIds().includes("cli_longview"));
    } finally {
      await stop(second);
    }
  })
);

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

if (POSTGRES_URL) {
  test("Postgres: approvals reuse the live product bearer and startup retires the old client ids once", async () => {
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: POSTGRES_URL,
    });
    try {
      await seedPreRegisteredClients([
        ...DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => ({
          ...client,
          metadata: { ...client.metadata },
        })),
        {
          client_id: OLD_CONSOLE_CLIENT,
          metadata: {
            client_name: "PDPP Polyfill Owner Bootstrap",
            token_endpoint_auth_method: "none",
          },
        },
        ...DEMO_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => ({
          ...client,
          metadata: { ...client.metadata },
        })),
      ]);
      const approveOwnerDevice = async (clientId: string) => {
        const device = await initiateOwnerDeviceAuthorization(clientId);
        return (await approveOwnerDeviceAuthorization(device.user_code, SUBJECT)).access_token as string;
      };
      const oldBearers: string[] = [];
      for (const clientId of OLD_CLIENT_IDS) oldBearers.push(await issueOwnerToken(SUBJECT, { clientId }));
      oldBearers.push(await approveOwnerDevice("cli_longview"));
      const pending = await initiateOwnerDeviceAuthorization("longview");
      const keptBearer = await issueOwnerToken(SUBJECT, {
        clientId: "pdpp_cli",
      });
      await postgresQuery(
        `INSERT INTO oauth_refresh_tokens(refresh_token_hash, family_id, generation, client_id, subject_id, status, created_at)
         VALUES ('rth_pg_old', 'fam_pg_old', 1, 'longview', $1, 'active', $2)`,
        [SUBJECT, new Date().toISOString()]
      );
      await postgresQuery(
        `INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, status, issued_at)
         VALUES ('grt_pg_concert', $1, 'concert_recommendation_app', '{}', 'continuous', 'active', $2)`,
        [SUBJECT, new Date().toISOString()]
      );
      const now = nowSeconds();
      const session = (id: string, createdAt: number, label: string, userAgent: string | null) =>
        postgresQuery(
          `INSERT INTO owner_sessions(id_hash, session_id, subject_id, device_key, label, user_agent, ip_address, created_at, expires_at, last_seen_at, revoked_at)
           VALUES ($1, $1, $2, NULL, $3, $4, NULL, $5, $6, $5, NULL)`,
          [id, SUBJECT, label, userAgent, createdAt, createdAt + 7 * 24 * 60 * 60]
        );
      await session("desktop_old_0001", now - 300, "Unknown browser", null);
      await session("desktop_old_0002", now - 200, "Unknown browser", null);
      await session("desktop_new_0003", now - 100, "Unknown browser", null);
      await session("firefox_0000_004", now - 400, "Firefox", "Firefox/140.0");

      const productIds = DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => client.client_id);
      assert.deepEqual(await retireFormerPreRegisteredClients(now, productIds), {
        clients: {
          cli_longview: {
            bearers: 2,
            deregistered: true,
            deviceRequests: 0,
            refreshTokens: 0,
          },
          concert_recommendation_app: {
            bearers: 1,
            deregistered: false,
            deviceRequests: 0,
            refreshTokens: 0,
          },
          longview: {
            bearers: 1,
            deregistered: true,
            deviceRequests: 1,
            refreshTokens: 1,
          },
          longview_planning_v1: {
            bearers: 1,
            deregistered: true,
            deviceRequests: 0,
            refreshTokens: 0,
          },
          "pdpp-polyfill-owner-bootstrap": {
            bearers: 1,
            deregistered: true,
            deviceRequests: 0,
            refreshTokens: 0,
          },
        },
        sessions: 2,
      });
      assert.deepEqual(
        await retireFormerPreRegisteredClients(now, productIds),
        { clients: {}, sessions: 0 },
        "a second run changes nothing"
      );
      for (const token of oldBearers) assert.equal(await isActive(token), false, "an old-id bearer is revoked");
      assert.equal(await isActive(keptBearer), true, "the pdpp_cli bearer still works");
      assert.equal(
        (
          await postgresQuery<{ status: string }>("SELECT status FROM owner_device_auth WHERE device_code = $1", [
            pending.device_code,
          ])
        ).rows[0]?.status,
        "expired"
      );
      assert.deepEqual(
        (
          await postgresQuery<{ id_hash: string }>(
            "SELECT id_hash FROM owner_sessions WHERE revoked_at IS NULL ORDER BY id_hash"
          )
        ).rows.map((row) => row.id_hash),
        ["desktop_new_0003", "firefox_0000_004"]
      );
      assert.deepEqual(
        (await postgresQuery<{ client_id: string }>("SELECT client_id FROM oauth_clients")).rows
          .map((row) => row.client_id)
          .sort(),
        ["concert_recommendation_app", ...PRODUCT_CLIENT_IDS].sort()
      );

      const consoleBearer = await approveOwnerDevice(CONSOLE_CLIENT);
      assert.equal(await approveOwnerDevice(CONSOLE_CLIENT), consoleBearer, "the console reuses its bearer");
      const runtime = await approveOwnerDevice(RUNTIME_CLIENT);
      assert.equal(await approveOwnerDevice(RUNTIME_CLIENT), runtime, "runs reuse one bearer");
      const cli = await approveOwnerDevice("pdpp_cli");
      assert.notEqual(await approveOwnerDevice("pdpp_cli"), cli, "other clients still get a new bearer");
    } finally {
      await closePostgresStorage();
    }
  });
} else {
  test(
    "Postgres: approvals reuse the live product bearer and startup retires the old client ids once (skipped: PDPP_TEST_POSTGRES_URL unset)",
    { skip: true },
    () => undefined
  );
}
