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
import { createHash } from "node:crypto";
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
import { getOwnerSessionStore } from "../server/stores/owner-session-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const TEST_PASSWORD = "placeholder-test-password";
const SUBJECT = "owner_local";
const CONSOLE_CLIENT = "dataconnect-console";
const RUNTIME_CLIENT = "dataconnect-connector-runtime";
/** The clients earlier versions pre-registered and this one retires. */

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
      keptForActiveGrant: boolean;
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
function spineEvents(eventType: string, clientId: string): Record<string, unknown>[] {
  return getDb()
    .prepare("SELECT actor_type, data_json FROM spine_events WHERE event_type = ? AND client_id = ? ORDER BY event_seq")
    .all<{ actor_type: string; data_json: string }>(eventType, clientId)
    .map((row) => ({ actor_type: row.actor_type, ...(JSON.parse(row.data_json) as Record<string, unknown>) }));
}

/** Approve an owner device request the way the console and the runtime do. */
async function approveAs(clientId: string, subjectId = SUBJECT): Promise<{ access_token: string; expires_in: number }> {
  const device = await initiateOwnerDeviceAuthorization(clientId);
  return (await approveOwnerDeviceAuthorization(device.user_code, subjectId)) as {
    access_token: string;
    expires_in: number;
  };
}

const DAY_SECONDS = 24 * 60 * 60;

/** Revoke an owner bearer the way Settings does, by its public id. */
async function revokeInSettings(token: string): Promise<void> {
  const publicId = `tok_${createHash("sha256").update(token).digest("base64url")}`;
  assert.equal(await getOwnerSessionStore().revokeOwnerBearer(SUBJECT, publicId, nowSeconds()), true);
}

function setExpiry(token: string, secondsFromNow: number): void {
  getDb()
    .prepare("UPDATE tokens SET expires_at = ? WHERE token_id = ?")
    .run(new Date(Date.now() + secondsFromNow * 1000).toISOString(), token);
}

test(
  "an approval never reuses a revoked, another subject's, or half-expired bearer",
  withDataDir(async (dataDir) => {
    const { server } = await start(join(dataDir, "pdpp.sqlite"));
    try {
      const revokedBearer = (await approveAs(RUNTIME_CLIENT)).access_token;
      await revokeInSettings(revokedBearer);
      assert.equal(await isActive(revokedBearer), false);
      const afterRevoke = (await approveAs(RUNTIME_CLIENT)).access_token;
      assert.notEqual(afterRevoke, revokedBearer, "a revoked bearer is not reused");
      assert.equal(await isActive(afterRevoke), true);

      const otherSubject = "owner_other";
      const othersBearer = await issueOwnerToken(otherSubject, { clientId: CONSOLE_CLIENT });
      const othersRow = () => getDb().prepare("SELECT * FROM tokens WHERE token_id = ?").get(othersBearer);
      const othersRowBefore = othersRow();
      const mine = await approveAs(CONSOLE_CLIENT);
      assert.notEqual(mine.access_token, othersBearer, "another subject's bearer is not returned");
      assert.equal((await introspect(mine.access_token)).subject_id, SUBJECT);
      assert.deepEqual(othersRow(), othersRowBefore, "the other subject's bearer is unchanged");

      // Less than half of its lifetime left: not reused.
      setExpiry(mine.access_token, 100 * DAY_SECONDS);
      const fresh = await approveAs(CONSOLE_CLIENT);
      assert.notEqual(fresh.access_token, mine.access_token, "a bearer below half its lifetime is not reused");
      assert.equal(fresh.expires_in, 365 * DAY_SECONDS);

      // More than half left: reused, with the lifetime it has left.
      setExpiry(fresh.access_token, 200 * DAY_SECONDS);
      const reused = await approveAs(CONSOLE_CLIENT);
      assert.equal(reused.access_token, fresh.access_token);
      assert.ok(
        reused.expires_in <= 200 * DAY_SECONDS && reused.expires_in > 200 * DAY_SECONDS - 60,
        `a reused bearer reports its remaining lifetime, got ${reused.expires_in}`
      );
      assert.deepEqual(
        spineEvents("consent.approved", CONSOLE_CLIENT).map((event) => event.reused ?? false),
        [false, false, true],
        "consent.approved marks the approval that reused a bearer"
      );
    } finally {
      await stop(server);
    }
  })
);

test(
  "connector runs reuse the runtime's bearer without a device approval per run",
  withDataDir(async (dataDir) => {
    const { server } = await start(join(dataDir, "pdpp.sqlite"));
    try {
      const deviceRows = () =>
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM owner_device_auth WHERE client_id = ?")
          .get<{ n: number }>(RUNTIME_CLIENT)?.n;
      const runs = 5;
      const tokens = new Set<string>();
      for (let run = 0; run < runs; run++) tokens.add(await server.controller.issueRuntimeOwnerToken(SUBJECT));
      assert.equal(tokens.size, 1);
      assert.equal(deviceRows(), 1, `${runs} runs create one device-auth row`);
      assert.equal(spineEvents("consent.approved", RUNTIME_CLIENT).length, 1, "and one consent.approved event");

      const [cached] = tokens;
      await revokeInSettings(cached as string);
      const afterRevoke = await server.controller.issueRuntimeOwnerToken(SUBJECT);
      assert.notEqual(afterRevoke, cached, "a revoked cached bearer is replaced");
      assert.equal(await isActive(afterRevoke), true);
      assert.equal(deviceRows(), 2);
    } finally {
      await stop(server);
    }
  })
);

test(
  "the runtime's cached bearer is per subject and replaced below half its lifetime",
  withDataDir(async (dataDir) => {
    const { server } = await start(join(dataDir, "pdpp.sqlite"));
    try {
      const mine = await server.controller.issueRuntimeOwnerToken(SUBJECT);
      const theirs = await server.controller.issueRuntimeOwnerToken("owner_other");
      assert.equal((await introspect(theirs)).subject_id, "owner_other", "a run for another subject gets that subject's bearer");
      assert.equal((await introspect(mine)).subject_id, SUBJECT);
      setExpiry(mine, 100 * DAY_SECONDS);
      const replaced = await server.controller.issueRuntimeOwnerToken(SUBJECT);
      assert.notEqual(replaced, mine, "a cached bearer below half its lifetime is replaced");
      assert.ok(((await introspect(replaced)).exp ?? 0) * 1000 > Date.now() + 364 * DAY_SECONDS * 1000);
    } finally {
      await stop(server);
    }
  })
);

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

if (POSTGRES_URL) {
  test("Postgres: approvals reuse the live product bearer", async () => {
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: POSTGRES_URL,
    });
    try {
      await seedPreRegisteredClients(
        DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => ({
          ...client,
          metadata: { ...client.metadata },
        }))
      );
      const approveOwnerDevice = async (clientId: string) => {
        const device = await initiateOwnerDeviceAuthorization(clientId);
        return (await approveOwnerDeviceAuthorization(device.user_code, SUBJECT)).access_token as string;
      };

      const othersBearer = await issueOwnerToken("owner_other", { clientId: CONSOLE_CLIENT });
      const consoleBearer = await approveOwnerDevice(CONSOLE_CLIENT);
      assert.notEqual(consoleBearer, othersBearer, "another subject's bearer is not returned");
      assert.equal((await introspect(othersBearer)).subject_id, "owner_other");
      assert.equal(await approveOwnerDevice(CONSOLE_CLIENT), consoleBearer, "the console reuses its bearer");
      assert.deepEqual(
        (
          await postgresQuery<{ reused: boolean | null }>(
            `SELECT (data_json->>'reused')::boolean AS reused FROM spine_events
              WHERE event_type = 'consent.approved' AND client_id = $1 ORDER BY event_seq`,
            [CONSOLE_CLIENT]
          )
        ).rows.map((row) => row.reused ?? false),
        [false, true],
        "consent.approved marks the approval that reused a bearer"
      );
      await revokeInSettings(consoleBearer);
      const afterRevoke = await approveOwnerDevice(CONSOLE_CLIENT);
      assert.notEqual(afterRevoke, consoleBearer, "a revoked bearer is not reused");
      assert.equal(await isActive(afterRevoke), true);
      await postgresQuery("UPDATE tokens SET expires_at = $1 WHERE token_id = $2", [
        new Date(Date.now() + 100 * DAY_SECONDS * 1000).toISOString(),
        afterRevoke,
      ]);
      const device = await initiateOwnerDeviceAuthorization(CONSOLE_CLIENT);
      const fresh = await approveOwnerDeviceAuthorization(device.user_code, SUBJECT);
      assert.notEqual(fresh.access_token, afterRevoke, "a bearer below half its lifetime is not reused");
      assert.equal(fresh.expires_in, 365 * DAY_SECONDS);
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
