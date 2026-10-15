// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto, { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import {
  issueRsCursor,
  RS_CURSOR_QUOTA,
  RS_CURSOR_TTL_MS,
  resolveRsCursor,
  rsCursorDigest,
} from "../server/rs-opaque-cursors.ts";
import { SqliteDriver } from "../server/sqlite-driver.ts";
import { openSqliteDatabase } from "../server/sqlite-encryption.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const { Pool } = pg;
const TEST_POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const TIMEOUT_ORACLE_CHILD = process.env.RS_CURSOR_TIMEOUT_ORACLE_CHILD === "1";
const CURSOR_FAULT_ORACLE = process.env.RS_CURSOR_FAULT_ORACLE;
const CURSOR_ISSUER_APP_NAME = "rs_opaque_cursor_test_issuer";
const SCOPE = { subject: "cursor-store-test" };
const CONTEXT = { connector: "mail", fields: ["id", "updated_at"] };
const NOW = 2_000_000_000_000;
const PUBLIC_TOKEN_PATTERN = /^pdc_[A-Za-z0-9_-]{32}$/;
const BARRIER_ISSUER_REJECTION = /injected barrier issuer rejection/;
const BATCH_OBSERVER_REJECTION = /injected batch observer rejection/;
type SqliteDatabaseForTest = ReturnType<typeof getDb>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestsImmediatelyAbove(value: string, count: number): string[] {
  const first = BigInt(`0x${value}`) + 1n;
  return Array.from({ length: count }, (_, index) => (first + BigInt(index)).toString(16).padStart(64, "0"));
}

async function withDeterministicTokenBytes<T>(run: () => Promise<T>): Promise<T> {
  mock.method(crypto, "randomBytes", (size: number) => Buffer.alloc(size, 1));
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

async function activeCursorIssuePids(pool: InstanceType<typeof Pool>, blockerPid?: number): Promise<number[]> {
  const result = await pool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND application_name = $2
        AND ($1::integer IS NULL OR $1 = ANY(pg_blocking_pids(pid)))`,
    [blockerPid ?? null, CURSOR_ISSUER_APP_NAME]
  );
  return result.rows.map((row) => Number(row.pid));
}

async function setCursorIssuerDefaults(databaseUrl: string, databaseName: string): Promise<void> {
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1, statement_timeout: 3000 });
  try {
    await admin.query(`ALTER DATABASE "${databaseName}" SET application_name = '${CURSOR_ISSUER_APP_NAME}'`);
    if (!CURSOR_FAULT_ORACLE) {
      await admin.query(`ALTER DATABASE "${databaseName}" SET statement_timeout = '8000ms'`);
      await admin.query(`ALTER DATABASE "${databaseName}" SET lock_timeout = '5000ms'`);
    }
  } finally {
    await admin.end();
  }
}

async function cancelCursorIssues(pool: InstanceType<typeof Pool>, blockerPid?: number): Promise<void> {
  const pids = await activeCursorIssuePids(pool, blockerPid);
  await Promise.all(pids.map((pid) => pool.query("SELECT pg_cancel_backend($1)", [pid])));
}

async function terminateCursorIssues(pool: InstanceType<typeof Pool>): Promise<void> {
  const pids = await activeCursorIssuePids(pool);
  await Promise.all(pids.map((pid) => pool.query("SELECT pg_terminate_backend($1)", [pid])));
}

function postgresTestSkipReason(): string | false {
  if (TIMEOUT_ORACLE_CHILD && !TEST_POSTGRES_URL) {
    return "PDPP_TEST_POSTGRES_URL is not configured";
  }
  if (!TEST_POSTGRES_URL) {
    return "PDPP_TEST_POSTGRES_URL is not configured";
  }
  return false;
}

async function assertTimeoutOracleSubprocessCompletes(): Promise<void> {
  assert.ok(TEST_POSTGRES_URL, "Postgres URL is required for the subprocess oracle");
  for (const fault of ["batch-observer", "barrier-issuer"]) {
    const databaseName = `ri_cursor_fault_${fault.replaceAll("-", "_")}_${process.pid}_${Date.now()}`;
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      RS_CURSOR_FAULT_DB_NAME: databaseName,
      RS_CURSOR_FAULT_ORACLE: fault,
      RS_CURSOR_TIMEOUT_ORACLE_CHILD: "1",
    };
    childEnvironment.NODE_TEST_CONTEXT = undefined;
    const child = spawn(
      process.execPath,
      ["--unhandled-rejections=strict", "--import", "tsx", "--test", fileURLToPath(import.meta.url)],
      {
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let output = "";
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    const forceDeadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
    }, 15_000);
    let childError: unknown;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: wait for each child before checking its independent database cleanup.
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      assert.equal(timedOut, false, `${fault} cleanup child must exit within 15 seconds`);
      assert.equal(signal, null, `${fault} cleanup child was signalled: ${output.slice(-1200)}`);
      assert.equal(code, 0, `${fault} cleanup child failed: ${output.slice(-1200)}`);
      assert.match(output, new RegExp(`cursor_fault_oracle_${fault}_database_dropped`));
    } catch (error) {
      childError = error;
    } finally {
      clearTimeout(forceDeadline);
      if (forceKill) {
        clearTimeout(forceKill);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    const adminUrl = new URL(TEST_POSTGRES_URL);
    adminUrl.pathname = "/postgres";
    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1, statement_timeout: 3000 });
    try {
      const dropped = await admin.query<{ dropped: boolean }>(
        "SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS dropped",
        [databaseName]
      );
      if (!dropped.rows[0]?.dropped) {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      }
      assert.equal(dropped.rows[0]?.dropped, true, `${fault} owned database must be dropped`);
    } finally {
      await admin.end();
    }
    if (childError) {
      throw childError;
    }
  }
}

function sqliteCount(db: SqliteDatabaseForTest = getDb()): number {
  return Number(db.prepare("SELECT count(*) AS count FROM rs_opaque_cursors").get<{ count: number }>()?.count ?? 0);
}

function sqliteDigests(db: SqliteDatabaseForTest = getDb()): string[] {
  return db
    .prepare("SELECT token_digest FROM rs_opaque_cursors ORDER BY token_digest")
    .all<{ token_digest: string }>()
    .map((row) => row.token_digest);
}

function seedSqliteRows(args: {
  count: number;
  createdAt?: number;
  expiresAt?: number;
  kind?: string;
  scopeDigest?: string;
  tokenDigests?: readonly string[];
}): void {
  const insert = getDb().prepare(
    `INSERT INTO rs_opaque_cursors
		 (token_digest, kind, scope_digest, context_digest, internal_cursor, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAll = getDb().transaction(() => {
    for (let index = 0; index < args.count; index += 1) {
      insert.run(
        args.tokenDigests?.[index] ??
          digest(`seed-${args.scopeDigest ?? "scope"}-${args.kind ?? "changes_since"}-${index}`),
        args.kind ?? "changes_since",
        args.scopeDigest ?? rsCursorDigest(SCOPE),
        rsCursorDigest(CONTEXT),
        `internal-${index}`,
        args.createdAt ?? NOW - 1000,
        args.expiresAt ?? NOW + RS_CURSOR_TTL_MS.changes_since
      );
    }
  });
  insertAll();
}

async function verifyBehaviorAndSqliteAtomicity(observerDb: SqliteDatabaseForTest): Promise<void> {
  const db = getDb();
  const tableAndIndexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE (type = 'table' AND name = 'rs_opaque_cursors') OR (type = 'index' AND name LIKE 'idx_rs_opaque_cursors%')"
    )
    .all<{ name: string }>()
    .map((row) => row.name);
  assert.deepEqual(
    tableAndIndexes.toSorted((left, right) => left.localeCompare(right)),
    ["rs_opaque_cursors", "idx_rs_opaque_cursors_expiry", "idx_rs_opaque_cursors_scope"].toSorted((left, right) =>
      left.localeCompare(right)
    )
  );

  const token = await issueRsCursor({
    context: CONTEXT,
    internalCursor: "opaque-position-7",
    kind: "page",
    now: NOW,
    scope: SCOPE,
  });
  const otherToken = await issueRsCursor({
    context: CONTEXT,
    internalCursor: "opaque-position-7",
    kind: "page",
    now: NOW,
    scope: SCOPE,
  });
  assert.equal(PUBLIC_TOKEN_PATTERN.test(token), true);
  assert.equal(token !== otherToken, true);
  assert.equal(token.includes("opaque-position-7"), false);
  const persistedDigest = db
    .prepare("SELECT token_digest FROM rs_opaque_cursors WHERE token_digest = ?")
    .get<{ token_digest: string }>(digest(token));
  assert.equal(persistedDigest?.token_digest === digest(token), true);
  assert.equal(
    db.prepare("SELECT token_digest FROM rs_opaque_cursors WHERE token_digest = ?").get(token) === undefined,
    true
  );
  assert.deepEqual(RS_CURSOR_TTL_MS, { changes_page: 86_400_000, changes_since: 2_592_000_000, page: 86_400_000 });
  assert.deepEqual(RS_CURSOR_QUOTA, { changes_page: 1000, changes_since: 100, page: 1000 });
  const reorderedContext: Record<string, unknown> = {};
  reorderedContext.fields = ["id", "updated_at"];
  reorderedContext.connector = "mail";
  assert.equal(rsCursorDigest(reorderedContext), rsCursorDigest(CONTEXT));
  const resolved = await resolveRsCursor({
    accept: ["page"],
    context: reorderedContext,
    now: NOW,
    param: "cursor",
    token,
  });
  assert.deepEqual(resolved, { internalCursor: "opaque-position-7", kind: "page" });
  const replay = await resolveRsCursor({ accept: ["page"], context: CONTEXT, now: NOW, param: "cursor", token });
  assert.equal(replay.internalCursor, "opaque-position-7");
  await assert.rejects(
    resolveRsCursor({
      accept: ["page"],
      context: { ...CONTEXT, connector: "calendar" },
      now: NOW,
      param: "cursor",
      token,
    }),
    (error: { code?: string }) => error.code === "invalid_cursor"
  );
  await assert.rejects(
    resolveRsCursor({ accept: ["changes_page"], context: CONTEXT, now: NOW, param: "cursor", token }),
    (error: { code?: string }) => error.code === "invalid_cursor"
  );
  await assert.rejects(
    resolveRsCursor({ accept: ["page"], context: CONTEXT, now: NOW, param: "cursor", token: "pdc_unknown" }),
    (error: { code?: string }) => error.code === "invalid_cursor"
  );
  await assert.rejects(
    resolveRsCursor({
      accept: ["changes_since"],
      context: CONTEXT,
      now: NOW,
      param: "changes_since",
      token: "pdc_unknown",
    }),
    (error: { code?: string }) => error.code === "cursor_expired"
  );
  const ttlToken = await issueRsCursor({
    context: CONTEXT,
    internalCursor: "ttl-position",
    kind: "changes_since",
    now: NOW,
    scope: SCOPE,
  });
  const stillLive = await resolveRsCursor({
    accept: ["changes_since"],
    context: CONTEXT,
    now: NOW + RS_CURSOR_TTL_MS.changes_since,
    param: "changes_since",
    token: ttlToken,
  });
  assert.equal(stillLive.internalCursor, "ttl-position");
  await assert.rejects(
    resolveRsCursor({
      accept: ["changes_since"],
      context: CONTEXT,
      now: NOW + RS_CURSOR_TTL_MS.changes_since + 1,
      param: "changes_since",
      token: ttlToken,
    }),
    (error: { code?: string }) => error.code === "cursor_expired"
  );

  getDb().prepare("DELETE FROM rs_opaque_cursors").run();
  seedSqliteRows({ count: RS_CURSOR_QUOTA.changes_since, scopeDigest: rsCursorDigest(SCOPE) });
  const before = sqliteDigests();
  try {
    getDb().exec(
      "CREATE TRIGGER reject_cursor_quota_eviction BEFORE DELETE ON rs_opaque_cursors BEGIN SELECT RAISE(ABORT, 'injected cursor prune failure'); END"
    );
    await assert.rejects(
      issueRsCursor({
        context: CONTEXT,
        internalCursor: "atomicity-probe",
        kind: "changes_since",
        now: NOW,
        scope: SCOPE,
      }),
      (error: { message?: string }) => error.message?.includes("injected cursor prune failure") === true
    );
    assert.equal(JSON.stringify(sqliteDigests(observerDb)) === JSON.stringify(before), true);
    assert.equal(sqliteCount(observerDb), RS_CURSOR_QUOTA.changes_since);
  } finally {
    getDb().exec("DROP TRIGGER IF EXISTS reject_cursor_quota_eviction");
  }
  await issueRsCursor({
    context: CONTEXT,
    internalCursor: "after-trigger",
    kind: "changes_since",
    now: NOW,
    scope: SCOPE,
  });
  assert.equal(sqliteCount(), RS_CURSOR_QUOTA.changes_since);

  getDb().prepare("DELETE FROM rs_opaque_cursors").run();
  seedSqliteRows({ count: RS_CURSOR_QUOTA.changes_since, createdAt: NOW + 1 });
  const olderIssuedToken = await issueRsCursor({
    context: CONTEXT,
    internalCursor: "older-issued-position",
    kind: "changes_since",
    now: NOW,
    scope: SCOPE,
  });
  assert.deepEqual(
    await resolveRsCursor({
      accept: ["changes_since"],
      context: CONTEXT,
      now: NOW,
      param: "changes_since",
      token: olderIssuedToken,
    }),
    { internalCursor: "older-issued-position", kind: "changes_since" }
  );

  getDb().prepare("DELETE FROM rs_opaque_cursors").run();
  await withDeterministicTokenBytes(async () => {
    const deterministicToken = `pdc_${Buffer.alloc(24, 1).toString("base64url")}`;
    seedSqliteRows({
      count: RS_CURSOR_QUOTA.changes_since,
      createdAt: NOW,
      tokenDigests: digestsImmediatelyAbove(digest(deterministicToken), RS_CURSOR_QUOTA.changes_since),
    });
    const tiedIssuedToken = await issueRsCursor({
      context: CONTEXT,
      internalCursor: "tied-issued-position",
      kind: "changes_since",
      now: NOW,
      scope: SCOPE,
    });
    assert.equal(digest(tiedIssuedToken) === digest(deterministicToken), true);
    assert.deepEqual(
      await resolveRsCursor({
        accept: ["changes_since"],
        context: CONTEXT,
        now: NOW,
        param: "changes_since",
        token: tiedIssuedToken,
      }),
      { internalCursor: "tied-issued-position", kind: "changes_since" }
    );
  });

  getDb().prepare("DELETE FROM rs_opaque_cursors").run();
  seedSqliteRows({ count: 1, expiresAt: NOW - 1, scopeDigest: "expired-scope" });
  await issueRsCursor({ context: CONTEXT, internalCursor: "cleanup", kind: "page", now: NOW, scope: SCOPE });
  assert.equal(sqliteCount(), 1);
  await issueRsCursor({
    context: CONTEXT,
    internalCursor: "other-scope",
    kind: "changes_page",
    now: NOW,
    scope: { subject: "other" },
  });
  assert.equal(sqliteCount(), 2);

  getDb().prepare("DELETE FROM rs_opaque_cursors").run();
  const scopeDigest = rsCursorDigest(SCOPE);
  const otherScopeDigest = rsCursorDigest({ subject: "other" });
  seedSqliteRows({ count: RS_CURSOR_QUOTA.changes_since, scopeDigest });
  seedSqliteRows({ count: 1, kind: "page", scopeDigest });
  seedSqliteRows({ count: 1, kind: "changes_since", scopeDigest: otherScopeDigest });
  await issueRsCursor({
    context: CONTEXT,
    internalCursor: "scope-kind-quota",
    kind: "changes_since",
    now: NOW,
    scope: SCOPE,
  });
  assert.equal(sqliteCount(), RS_CURSOR_QUOTA.changes_since + 2);
  const retainedIsolatedRows = getDb()
    .prepare("SELECT count(*) AS count FROM rs_opaque_cursors WHERE token_digest IN (?, ?)")
    .get<{ count: number }>(
      digest(`seed-${scopeDigest}-page-0`),
      digest(`seed-${otherScopeDigest}-changes_since-0`)
    )?.count;
  assert.equal(retainedIsolatedRows, 2);

  getDb().prepare("DELETE FROM rs_opaque_cursors").run();
  const concurrent = await Promise.all(
    Array.from({ length: 300 }, (_, index) =>
      issueRsCursor({
        context: CONTEXT,
        internalCursor: `parallel-${index}`,
        kind: "changes_since",
        now: NOW,
        scope: SCOPE,
      })
    )
  );
  assert.equal(concurrent.length, 300);
  assert.ok(sqliteCount() <= RS_CURSOR_QUOTA.changes_since);
  assert.equal(sqliteCount(), RS_CURSOR_QUOTA.changes_since);

  getDb().exec("DROP TABLE rs_opaque_cursors");
  await assert.rejects(
    issueRsCursor({ context: CONTEXT, internalCursor: "no-ddl", kind: "page", now: NOW, scope: SCOPE })
  );
  await assert.rejects(resolveRsCursor({ accept: ["page"], context: CONTEXT, now: NOW, param: "cursor", token }));
  const recreated = Number(
    getDb()
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'rs_opaque_cursors'")
      .get<{ count: number }>()?.count ?? 0
  );
  assert.equal(recreated, 0);
}

test("SQLite opaque cursors preserve utility semantics and issue atomically", {
  skip: TIMEOUT_ORACLE_CHILD ? "Postgres cleanup subprocess only" : false,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "rs-opaque-cursors-"));
  const databasePath = join(directory, "cursors.sqlite");
  const encryptionOptions = process.env.PDPP_DATABASE_ENCRYPTION_KEY
    ? { encryptionKey: process.env.PDPP_DATABASE_ENCRYPTION_KEY }
    : {};
  let observerDb: SqliteDatabaseForTest | null = null;
  try {
    initDb(databasePath, encryptionOptions);
    observerDb = openSqliteDatabase(
      SqliteDriver,
      databasePath,
      30_000,
      encryptionOptions
    ) as unknown as SqliteDatabaseForTest;
    await verifyBehaviorAndSqliteAtomicity(observerDb);
  } finally {
    observerDb?.close();
    closeDb();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Postgres opaque cursors bootstrap cold and issue atomically", { skip: postgresTestSkipReason() }, async () => {
  const dbName = process.env.RS_CURSOR_FAULT_DB_NAME ?? `ri_cursor_${process.pid}_${Date.now()}`;
  let pool: InstanceType<typeof Pool> | null = null;
  let batchBarrier: pg.PoolClient | null = null;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: async () => {
        await closePostgresStorage();
        if (batchBarrier) {
          await batchBarrier.query("ROLLBACK").catch(() => undefined);
          batchBarrier.release();
          batchBarrier = null;
        }
        if (pool) {
          await pool.end();
        }
      },
      connectionString: TEST_POSTGRES_URL as string,
      databaseName: dbName,
      templateName: null,
    },
    async (databaseUrl) => {
      await setCursorIssuerDefaults(databaseUrl, dbName);
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      pool = new Pool({
        connectionString: databaseUrl,
        max: 8,
        options: "-c application_name=rs_opaque_cursor_test_external -c statement_timeout=5000 -c lock_timeout=4000",
      });
      const external = pool;
      const catalog = await external.query<{ name: string }>(
        "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'rs_opaque_cursors' UNION ALL SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'rs_opaque_cursors'"
      );
      assert.deepEqual(
        catalog.rows.map((row) => row.name).sort(),
        [
          "idx_rs_opaque_cursors_expiry",
          "idx_rs_opaque_cursors_scope",
          "rs_opaque_cursors",
          "rs_opaque_cursors_pkey",
        ].sort()
      );

      const count = async () =>
        Number(
          (await external.query<{ count: string }>("SELECT count(*)::text AS count FROM rs_opaque_cursors")).rows[0]
            ?.count ?? 0
        );
      const seed = async (args: {
        count: number;
        createdAt?: number;
        expiresAt?: number;
        kind?: string;
        scopeDigest?: string;
        tokenDigests?: readonly string[];
      }) => {
        const kind = args.kind ?? "changes_since";
        const scopeDigest = args.scopeDigest ?? rsCursorDigest(SCOPE);
        const indexes = Array.from({ length: args.count }, (_, index) => index);
        await external.query(
          `INSERT INTO rs_opaque_cursors
					 (token_digest, kind, scope_digest, context_digest, internal_cursor, created_at, expires_at)
					 SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[])`,
          [
            indexes.map((index) => args.tokenDigests?.[index] ?? digest(`pg-seed-${scopeDigest}-${kind}-${index}`)),
            indexes.map(() => kind),
            indexes.map(() => scopeDigest),
            indexes.map(() => rsCursorDigest(CONTEXT)),
            indexes.map((index) => `internal-${index}`),
            indexes.map(() => args.createdAt ?? NOW - 1000),
            indexes.map(() => args.expiresAt ?? NOW + RS_CURSOR_TTL_MS.changes_since),
          ]
        );
      };
      const digests = async () =>
        (
          await external.query<{ token_digest: string }>(
            "SELECT token_digest FROM rs_opaque_cursors ORDER BY token_digest"
          )
        ).rows.map((row) => row.token_digest);

      const token = await issueRsCursor({
        context: CONTEXT,
        internalCursor: "pg-position-7",
        kind: "page",
        now: NOW,
        scope: SCOPE,
      });
      const otherToken = await issueRsCursor({
        context: CONTEXT,
        internalCursor: "pg-position-7",
        kind: "page",
        now: NOW,
        scope: SCOPE,
      });
      assert.equal(PUBLIC_TOKEN_PATTERN.test(token), true);
      assert.equal(token !== otherToken, true);
      assert.equal(token.includes("pg-position-7"), false);
      const persistedDigest = await external.query<{ token_digest: string }>(
        "SELECT token_digest FROM rs_opaque_cursors WHERE token_digest = $1",
        [digest(token)]
      );
      assert.equal(persistedDigest.rows[0]?.token_digest === digest(token), true);
      const persistedRawToken = await external.query<{ token_digest: string }>(
        "SELECT token_digest FROM rs_opaque_cursors WHERE token_digest = $1",
        [token]
      );
      assert.equal(persistedRawToken.rowCount, 0);
      assert.deepEqual(RS_CURSOR_TTL_MS, {
        changes_page: 86_400_000,
        changes_since: 2_592_000_000,
        page: 86_400_000,
      });
      assert.deepEqual(RS_CURSOR_QUOTA, { changes_page: 1000, changes_since: 100, page: 1000 });
      const reorderedPgContext: Record<string, unknown> = {};
      reorderedPgContext.fields = ["id", "updated_at"];
      reorderedPgContext.connector = "mail";
      assert.equal(rsCursorDigest(reorderedPgContext), rsCursorDigest(CONTEXT));
      assert.deepEqual(
        await resolveRsCursor({ accept: ["page"], context: reorderedPgContext, now: NOW, param: "cursor", token }),
        { internalCursor: "pg-position-7", kind: "page" }
      );
      await assert.rejects(
        resolveRsCursor({
          accept: ["page"],
          context: { ...CONTEXT, connector: "calendar" },
          now: NOW,
          param: "cursor",
          token,
        }),
        (error: { code?: string }) => error.code === "invalid_cursor"
      );
      await assert.rejects(
        resolveRsCursor({ accept: ["changes_page"], context: CONTEXT, now: NOW, param: "cursor", token }),
        (error: { code?: string }) => error.code === "invalid_cursor"
      );
      await assert.rejects(
        resolveRsCursor({ accept: ["page"], context: CONTEXT, now: NOW, param: "cursor", token: "pdc_unknown" }),
        (error: { code?: string }) => error.code === "invalid_cursor"
      );
      await assert.rejects(
        resolveRsCursor({
          accept: ["changes_since"],
          context: CONTEXT,
          now: NOW,
          param: "changes_since",
          token: "pdc_unknown",
        }),
        (error: { code?: string }) => error.code === "cursor_expired"
      );
      const ttlToken = await issueRsCursor({
        context: CONTEXT,
        internalCursor: "ttl-position",
        kind: "changes_since",
        now: NOW,
        scope: SCOPE,
      });
      assert.equal(
        (
          await resolveRsCursor({
            accept: ["changes_since"],
            context: CONTEXT,
            now: NOW + RS_CURSOR_TTL_MS.changes_since,
            param: "changes_since",
            token: ttlToken,
          })
        ).internalCursor,
        "ttl-position"
      );
      await assert.rejects(
        resolveRsCursor({
          accept: ["changes_since"],
          context: CONTEXT,
          now: NOW + RS_CURSOR_TTL_MS.changes_since + 1,
          param: "changes_since",
          token: ttlToken,
        }),
        (error: { code?: string }) => error.code === "cursor_expired"
      );

      await external.query("DELETE FROM rs_opaque_cursors");
      await seed({ count: RS_CURSOR_QUOTA.changes_since });
      const before = await digests();
      try {
        await external.query(
          "CREATE FUNCTION reject_cursor_quota_eviction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cursor prune failure'; END $$"
        );
        await external.query(
          "CREATE TRIGGER reject_cursor_quota_eviction BEFORE DELETE ON rs_opaque_cursors FOR EACH ROW EXECUTE FUNCTION reject_cursor_quota_eviction()"
        );
        await assert.rejects(
          issueRsCursor({
            context: CONTEXT,
            internalCursor: "atomicity-probe",
            kind: "changes_since",
            now: NOW,
            scope: SCOPE,
          }),
          (error: { message?: string }) => error.message?.includes("injected cursor prune failure") === true
        );
        assert.equal(JSON.stringify(await digests()) === JSON.stringify(before), true);
        assert.equal(await count(), RS_CURSOR_QUOTA.changes_since);
      } finally {
        await external.query("DROP TRIGGER IF EXISTS reject_cursor_quota_eviction ON rs_opaque_cursors");
        await external.query("DROP FUNCTION IF EXISTS reject_cursor_quota_eviction()");
      }
      await issueRsCursor({
        context: CONTEXT,
        internalCursor: "after-trigger",
        kind: "changes_since",
        now: NOW,
        scope: SCOPE,
      });
      assert.equal(await count(), RS_CURSOR_QUOTA.changes_since);

      await external.query("DELETE FROM rs_opaque_cursors");
      await seed({ count: RS_CURSOR_QUOTA.changes_since, createdAt: NOW + 1 });
      const olderIssuedToken = await issueRsCursor({
        context: CONTEXT,
        internalCursor: "older-issued-position",
        kind: "changes_since",
        now: NOW,
        scope: SCOPE,
      });
      assert.deepEqual(
        await resolveRsCursor({
          accept: ["changes_since"],
          context: CONTEXT,
          now: NOW,
          param: "changes_since",
          token: olderIssuedToken,
        }),
        { internalCursor: "older-issued-position", kind: "changes_since" }
      );

      await external.query("DELETE FROM rs_opaque_cursors");
      await withDeterministicTokenBytes(async () => {
        const deterministicToken = `pdc_${Buffer.alloc(24, 1).toString("base64url")}`;
        await seed({
          count: RS_CURSOR_QUOTA.changes_since,
          createdAt: NOW,
          tokenDigests: digestsImmediatelyAbove(digest(deterministicToken), RS_CURSOR_QUOTA.changes_since),
        });
        const tiedIssuedToken = await issueRsCursor({
          context: CONTEXT,
          internalCursor: "tied-issued-position",
          kind: "changes_since",
          now: NOW,
          scope: SCOPE,
        });
        assert.equal(digest(tiedIssuedToken) === digest(deterministicToken), true);
        assert.deepEqual(
          await resolveRsCursor({
            accept: ["changes_since"],
            context: CONTEXT,
            now: NOW,
            param: "changes_since",
            token: tiedIssuedToken,
          }),
          { internalCursor: "tied-issued-position", kind: "changes_since" }
        );
      });

      await external.query("DELETE FROM rs_opaque_cursors");
      await seed({ count: 1, expiresAt: NOW - 1, scopeDigest: "expired-scope" });
      await issueRsCursor({ context: CONTEXT, internalCursor: "cleanup", kind: "page", now: NOW, scope: SCOPE });
      assert.equal(await count(), 1);
      await issueRsCursor({
        context: CONTEXT,
        internalCursor: "other-scope",
        kind: "changes_page",
        now: NOW,
        scope: { subject: "other" },
      });
      assert.equal(await count(), 2);

      await external.query("DELETE FROM rs_opaque_cursors");
      const scopeDigest = rsCursorDigest(SCOPE);
      const otherScopeDigest = rsCursorDigest({ subject: "other" });
      await seed({ count: RS_CURSOR_QUOTA.changes_since, scopeDigest });
      await seed({ count: 1, kind: "page", scopeDigest });
      await seed({ count: 1, kind: "changes_since", scopeDigest: otherScopeDigest });
      await issueRsCursor({
        context: CONTEXT,
        internalCursor: "scope-kind-quota",
        kind: "changes_since",
        now: NOW,
        scope: SCOPE,
      });
      assert.equal(await count(), RS_CURSOR_QUOTA.changes_since + 2);
      const isolatedRows = await external.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rs_opaque_cursors WHERE token_digest = ANY($1::text[])",
        [[digest(`pg-seed-${scopeDigest}-page-0`), digest(`pg-seed-${otherScopeDigest}-changes_since-0`)]]
      );
      assert.equal(Number(isolatedRows.rows[0]?.count), 2);

      await external.query("DELETE FROM rs_opaque_cursors");
      await seed({ count: RS_CURSOR_QUOTA.changes_since });
      const blocker = await external.connect();
      let issuing: Promise<string> | null = null;
      let issueSettled = false;
      let blockerPid: number | undefined;
      let barrierError: unknown;
      let issueOutcome: Promise<{ error?: unknown; value?: string }> | null = null;
      try {
        await blocker.query("BEGIN");
        blockerPid = Number((await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
        await blocker.query(
          "SELECT token_digest FROM rs_opaque_cursors WHERE scope_digest = $1 AND kind = 'changes_since' ORDER BY created_at, token_digest LIMIT 1 FOR UPDATE",
          [rsCursorDigest(SCOPE)]
        );
        let settled = false;
        issuing =
          CURSOR_FAULT_ORACLE === "barrier-issuer"
            ? Promise.reject(new Error("injected barrier issuer rejection"))
            : issueRsCursor({
                context: CONTEXT,
                internalCursor: "visibility-probe",
                kind: "changes_since",
                now: NOW,
                scope: SCOPE,
              });
        issueOutcome = issuing
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error })
          )
          .then((outcome) => {
            settled = true;
            issueSettled = true;
            return outcome;
          });
        let blocked = false;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !blocked) {
          // biome-ignore lint/performance/noAwaitInLoops: poll the independent lock state until issuance blocks or its deadline expires.
          const state = await Promise.race([
            external
              .query<{ blocked: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND pid <> $1 AND wait_event_type = 'Lock') AS blocked",
                [blockerPid]
              )
              .then((result) => ({ blocked: Boolean(result.rows[0]?.blocked) })),
            issueOutcome.then((outcome) => ({ issue: outcome })),
          ]);
          if ("issue" in state) {
            throw state.issue.error ?? new Error("visibility issuer completed before row-lock barrier");
          }
          ({ blocked } = state);
          if (!blocked) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        assert.equal(blocked, true);
        assert.equal(settled, false);
        const visibleWhilePruning = await count();
        try {
          assert.equal(visibleWhilePruning, RS_CURSOR_QUOTA.changes_since);
        } finally {
          await blocker.query("ROLLBACK");
        }
      } catch (error) {
        barrierError = error;
      } finally {
        if (!issueSettled && blockerPid !== undefined) {
          try {
            await cancelCursorIssues(external);
          } catch (error) {
            barrierError ??= error;
          }
        }
        try {
          await blocker.query("ROLLBACK");
        } catch {
          /* already released */
        }
        if (issuing) {
          const settledBeforeDeadline = await Promise.race([
            issueOutcome?.then(() => true) ?? Promise.resolve(false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
          ]);
          if (settledBeforeDeadline) {
            const outcome = await issueOutcome;
            if (outcome?.error) {
              barrierError ??= outcome.error;
            }
          } else {
            try {
              await cancelCursorIssues(external);
              await terminateCursorIssues(external);
            } catch (error) {
              barrierError ??= error;
            }
            const settledAfterCancellation = await Promise.race([
              issueOutcome?.then(() => true) ?? Promise.resolve(false),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
            ]);
            if (settledAfterCancellation) {
              const outcome = await issueOutcome;
              if (outcome?.error) {
                barrierError ??= outcome.error;
              }
            } else {
              barrierError ??= new Error("visibility issuer did not settle before bounded cleanup deadline");
            }
          }
        }
        blocker.release();
      }
      if (barrierError) {
        if (CURSOR_FAULT_ORACLE === "barrier-issuer") {
          assert.match(String(barrierError), BARRIER_ISSUER_REJECTION);
        } else {
          throw barrierError;
        }
      }
      assert.equal(await count(), RS_CURSOR_QUOTA.changes_since);

      await external.query("DELETE FROM rs_opaque_cursors");
      await seed({ count: RS_CURSOR_QUOTA.changes_since });
      batchBarrier = CURSOR_FAULT_ORACLE === "batch-observer" ? await external.connect() : null;
      let batchBlockerPid: number | undefined;
      if (batchBarrier) {
        await batchBarrier.query("BEGIN");
        await batchBarrier.query(
          "SELECT token_digest FROM rs_opaque_cursors WHERE scope_digest = $1 AND kind = 'changes_since' ORDER BY created_at, token_digest LIMIT 1 FOR UPDATE",
          [rsCursorDigest(SCOPE)]
        );
        batchBlockerPid = Number(
          (await batchBarrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid
        );
      }
      let maxObserved = 0;
      let observing = true;
      const observer = (async () => {
        const deadline = Date.now() + 20_000;
        while (observing && Date.now() < deadline) {
          // biome-ignore lint/performance/noAwaitInLoops: sample committed count serially to capture every intermediate state.
          maxObserved = Math.max(maxObserved, await count());
          if (CURSOR_FAULT_ORACLE === "batch-observer") {
            let oldestRowBlocked = false;
            const blockDeadline = Date.now() + 4000;
            while (!oldestRowBlocked && Date.now() < blockDeadline) {
              // biome-ignore lint/performance/noAwaitInLoops: poll until the first issuer is blocked in quota pruning.
              const result = await external.query<{ blocked: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND $2 = ANY(pg_blocking_pids(pid))) AS blocked",
                [CURSOR_ISSUER_APP_NAME, batchBlockerPid]
              );
              oldestRowBlocked = Boolean(result.rows[0]?.blocked);
              if (!oldestRowBlocked) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }
            assert.equal(oldestRowBlocked, true, "batch issuer must block while pruning the locked oldest row");
            throw new Error("injected batch observer rejection");
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (observing) {
          throw new Error("cursor concurrency observer exceeded its deadline");
        }
      })();
      const observerOutcome = observer.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ error })
      );
      let settledIssues = 0;
      const issuePromises = Array.from({ length: 300 }, (_, index) =>
        issueRsCursor({
          context: CONTEXT,
          internalCursor: `parallel-${index}`,
          kind: "changes_since",
          now: NOW,
          scope: SCOPE,
        }).finally(() => {
          settledIssues += 1;
        })
      );
      const batch = Promise.all(issuePromises);
      const batchOutcome = batch.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      let issued: string[] | undefined;
      let batchError: unknown;
      let observerError: unknown;
      let drainError: unknown;
      let issuerCleanupError: unknown;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          batchOutcome,
          observerOutcome,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("cursor concurrency oracle timed out")), 12_000);
          }),
        ]);
        if ("error" in outcome) {
          throw outcome.error;
        }
        if ("value" in outcome) {
          issued = outcome.value;
        }
      } catch (error) {
        batchError = error;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        observing = false;
        if (batchError) {
          const cleanupDeadline = Date.now() + 6000;
          while (settledIssues < issuePromises.length && Date.now() < cleanupDeadline) {
            try {
              // biome-ignore lint/performance/noAwaitInLoops: cancel issuers until all issue promises settle or bounded cleanup expires.
              await cancelCursorIssues(external);
            } catch (error) {
              issuerCleanupError ??= error;
            }
            if (Date.now() + 2500 >= cleanupDeadline) {
              try {
                await terminateCursorIssues(external);
              } catch (error) {
                issuerCleanupError ??= error;
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        if (settledIssues !== issuePromises.length) {
          batchError ??= new Error("cursor issuance promises did not drain before bounded cleanup deadline");
          try {
            await cancelCursorIssues(external);
          } catch (error) {
            issuerCleanupError ??= error;
          }
          try {
            await terminateCursorIssues(external);
          } catch (error) {
            issuerCleanupError ??= error;
          }
        }
        const fullyDrained = await Promise.race([
          Promise.allSettled(issuePromises).then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
        ]);
        if (!fullyDrained) {
          drainError = new Error("cursor issuance batch remained pending after cancellation and termination");
        }
        const observerResult = await observerOutcome;
        if ("error" in observerResult) {
          observerError = observerResult.error;
        }
      }
      if (batchError && CURSOR_FAULT_ORACLE === "batch-observer") {
        assert.match(String(observerError), BATCH_OBSERVER_REJECTION);
        assert.equal(settledIssues, issuePromises.length, "fault cleanup must settle every started issue");
        if (drainError) {
          throw drainError;
        }
        if (issuerCleanupError) {
          throw issuerCleanupError;
        }
        if (batchError !== observerError && (batchError as { code?: unknown } | null)?.code !== "57014") {
          throw batchError;
        }
      } else {
        const failures = [batchError, observerError, drainError, issuerCleanupError].filter(
          (error) => error !== undefined
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "cursor issue batch and cleanup failed");
        }
      }
      if (!CURSOR_FAULT_ORACLE) {
        assert.equal(issued?.length, 300);
        assert.ok(maxObserved <= RS_CURSOR_QUOTA.changes_since);
        assert.ok((await count()) <= RS_CURSOR_QUOTA.changes_since);
        assert.equal(await count(), RS_CURSOR_QUOTA.changes_since);
      }

      if (!CURSOR_FAULT_ORACLE) {
        await external.query("DROP TABLE rs_opaque_cursors");
        await assert.rejects(
          issueRsCursor({ context: CONTEXT, internalCursor: "no-ddl", kind: "page", now: NOW, scope: SCOPE })
        );
        await assert.rejects(resolveRsCursor({ accept: ["page"], context: CONTEXT, now: NOW, param: "cursor", token }));
        const recreated = await external.query<{ exists: boolean }>(
          "SELECT to_regclass('rs_opaque_cursors') IS NOT NULL AS exists"
        );
        assert.equal(recreated.rows[0]?.exists, false);
      }
    }
  );
  if (TIMEOUT_ORACLE_CHILD) {
    process.stdout.write(`cursor_fault_oracle_${CURSOR_FAULT_ORACLE}_database_dropped\n`);
  } else {
    await assertTimeoutOracleSubprocessCompletes();
  }
});
