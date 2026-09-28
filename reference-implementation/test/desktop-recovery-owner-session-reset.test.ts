// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end check of the desktop recovery-kit startup contract. The desktop
 * (`import_database_encryption_recovery_code` in src-tauri/src/unified.rs)
 * restarts the RI on the same data directory with:
 *   - PDPP_RECOVERY_REVOKE_OWNER_SESSIONS=1 in the RI environment,
 *   - owner-session-recovery-reset.json in PDPP_DATA_DIR,
 *   - for a v1 kit, credential-recovery-state.json in PDPP_DATA_DIR.
 * The file bodies below are the ones the Rust side writes; its unit tests
 * pin the same JSON.
 *
 * The test signs in, stops the server, applies those inputs, starts a new
 * server on the same database, and checks the old owner session is refused.
 *
 * The desktop uses the same inputs after an owner password change, with
 * reason "password_change" in the reset file. The RI logs that reason, so
 * a password change is not reported as a recovery.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import pino from "pino";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const TEST_PASSWORD = "placeholder-test-password";
const REVOKE_ENV = "PDPP_RECOVERY_REVOKE_OWNER_SESSIONS";
const RESET_FILE = "owner-session-recovery-reset.json";
const MARKER_FILE = "credential-recovery-state.json";

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
    [server.asServer, server.rsServer].map(
      (srv) => new Promise<void>((resolve) => srv.close(() => resolve()))
    )
  );
  closeDb();
}

async function start(
  dbPath: string,
  logLines: string[] = []
): Promise<{ server: StartedServer; asUrl: string }> {
  const logger = pino(
    { level: "warn" },
    new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(String(chunk));
        callback();
      },
    })
  );
  const server = (await startServer({
    asPort: 0,
    dbPath,
    logger,
    ownerAuthPassword: TEST_PASSWORD,
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  return { server, asUrl: `http://localhost:${server.asPort}` };
}

function cookiePair(resp: Response, name: string): string | null {
  for (const header of resp.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (pair?.startsWith(`${name}=`)) return pair;
  }
  return null;
}

async function login(asUrl: string): Promise<string> {
  const page = await fetch(`${asUrl}/owner/login`, { headers: { Accept: "text/html" }, redirect: "manual" });
  const csrfCookie = cookiePair(page, "pdpp_owner_csrf");
  const csrfField = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrfCookie && csrfField, "login page issues a CSRF token");
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField, password: TEST_PASSWORD, return_to: "/" }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie,
    },
    method: "POST",
    redirect: "manual",
  });
  const session = cookiePair(resp, "pdpp_owner_session");
  assert.ok(session, `login sets an owner session cookie (status ${resp.status})`);
  return session;
}

async function sessionStatus(asUrl: string, cookie: string): Promise<number> {
  return (await fetch(`${asUrl}/owner/session`, { headers: { Cookie: cookie }, redirect: "manual" })).status;
}

test("desktop recovery startup revokes owner sessions issued before the recovery", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-desktop-recovery-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  const previousRevoke = process.env[REVOKE_ENV];
  process.env.PDPP_DATA_DIR = dataDir;
  delete process.env[REVOKE_ENV];
  const dbPath = join(dataDir, "pdpp.sqlite");
  try {
    const before = await start(dbPath);
    let oldSession: string;
    try {
      oldSession = await login(before.asUrl);
      assert.equal(await sessionStatus(before.asUrl, oldSession), 204, "session works before recovery");
    } finally {
      await stop(before.server);
    }

    // Recovery startup inputs, as written by the desktop for a v1 kit.
    process.env[REVOKE_ENV] = "1";
    writeFileSync(join(dataDir, RESET_FILE), JSON.stringify({ version: 1, reason: "recovery" }));
    writeFileSync(
      join(dataDir, MARKER_FILE),
      JSON.stringify({ version: 1, cause: "legacy_v1_kit_missing_credential_key" })
    );

    const logLines: string[] = [];
    const after = await start(dbPath, logLines);
    try {
      assert.equal(await sessionStatus(after.asUrl, oldSession), 401, "pre-recovery owner session is rejected");
      const fresh = await login(after.asUrl);
      assert.equal(await sessionStatus(after.asUrl, fresh), 204, "the owner can sign in again after recovery");
    } finally {
      await stop(after.server);
    }
    assert.ok(existsSync(join(dataDir, `${RESET_FILE}.applied`)), "RI consumed the reset file");
    assert.ok(
      logLines.some((line) => {
        const entry = JSON.parse(line) as { msg?: string; reason?: string };
        return (
          entry.reason === "recovery" &&
          entry.msg === "recovery startup revoked existing owner sessions and owner bearers before serving"
        );
      }),
      "the RI logs the revocation as a recovery"
    );
    assert.ok(existsSync(join(dataDir, `${MARKER_FILE}.applied`)), "RI consumed the credential marker");
    assert.ok(!existsSync(join(dataDir, MARKER_FILE)), "no unconsumed credential marker remains");
  } finally {
    if (previousDataDir === undefined) delete process.env.PDPP_DATA_DIR;
    else process.env.PDPP_DATA_DIR = previousDataDir;
    if (previousRevoke === undefined) delete process.env[REVOKE_ENV];
    else process.env[REVOKE_ENV] = previousRevoke;
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("desktop password-change startup revokes owner sessions and logs a password change", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-desktop-password-change-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  const previousRevoke = process.env[REVOKE_ENV];
  process.env.PDPP_DATA_DIR = dataDir;
  delete process.env[REVOKE_ENV];
  const dbPath = join(dataDir, "pdpp.sqlite");
  try {
    const before = await start(dbPath);
    let oldSession: string;
    try {
      oldSession = await login(before.asUrl);
    } finally {
      await stop(before.server);
    }

    // Password-change startup inputs, as written by the desktop.
    process.env[REVOKE_ENV] = "1";
    writeFileSync(join(dataDir, RESET_FILE), JSON.stringify({ version: 1, reason: "password_change" }));

    const logLines: string[] = [];
    const after = await start(dbPath, logLines);
    try {
      assert.equal(await sessionStatus(after.asUrl, oldSession), 401, "pre-change owner session is rejected");
    } finally {
      await stop(after.server);
    }
    const revoked = logLines
      .map((line) => JSON.parse(line) as { msg?: string; reason?: string })
      .filter((entry) => entry.msg?.includes("revoked existing owner sessions"));
    assert.deepEqual(
      revoked.map((entry) => [entry.reason, entry.msg]),
      [
        [
          "password_change",
          "owner password change revoked existing owner sessions and owner bearers before serving",
        ],
      ]
    );
  } finally {
    if (previousDataDir === undefined) delete process.env.PDPP_DATA_DIR;
    else process.env.PDPP_DATA_DIR = previousDataDir;
    if (previousRevoke === undefined) delete process.env[REVOKE_ENV];
    else process.env[REVOKE_ENV] = previousRevoke;
    rmSync(dataDir, { force: true, recursive: true });
  }
});
