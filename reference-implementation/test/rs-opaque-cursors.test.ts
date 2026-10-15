// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
const SCOPE = { subject: "cursor-store-test" };
const CONTEXT = { connector: "mail", fields: ["id", "updated_at"] };
const NOW = 2_000_000_000_000;
const PUBLIC_TOKEN_PATTERN = /^pdc_[A-Za-z0-9_-]{32}$/;
type SqliteDatabaseForTest = ReturnType<typeof getDb>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
}): void {
  const insert = getDb().prepare(
    `INSERT INTO rs_opaque_cursors
		 (token_digest, kind, scope_digest, context_digest, internal_cursor, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAll = getDb().transaction(() => {
    for (let index = 0; index < args.count; index += 1) {
      insert.run(
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
    tableAndIndexes.sort(),
    ["rs_opaque_cursors", "idx_rs_opaque_cursors_expiry", "idx_rs_opaque_cursors_scope"].sort()
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

test("SQLite opaque cursors preserve utility semantics and issue atomically", async () => {
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

test("Postgres opaque cursors bootstrap cold and issue atomically", { skip: !TEST_POSTGRES_URL }, async () => {
  const dbName = `ri_cursor_${process.pid}_${Date.now()}`;
  let pool: InstanceType<typeof Pool> | null = null;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: async () => {
        await closePostgresStorage();
        if (pool) {
          await pool.end();
        }
      },
      connectionString: TEST_POSTGRES_URL as string,
      databaseName: dbName,
      templateName: null,
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      pool = new Pool({ connectionString: databaseUrl, max: 8 });
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
      }) => {
        const kind = args.kind ?? "changes_since";
        const scopeDigest = args.scopeDigest ?? rsCursorDigest(SCOPE);
        const indexes = Array.from({ length: args.count }, (_, index) => index);
        await external.query(
          `INSERT INTO rs_opaque_cursors
					 (token_digest, kind, scope_digest, context_digest, internal_cursor, created_at, expires_at)
					 SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[])`,
          [
            indexes.map((index) => digest(`pg-seed-${scopeDigest}-${kind}-${index}`)),
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
      assert.deepEqual(RS_CURSOR_TTL_MS, { changes_page: 86_400_000, changes_since: 2_592_000_000, page: 86_400_000 });
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
      let barrierError: unknown;
      try {
        await blocker.query("BEGIN");
        const blockerPid = Number(
          (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid
        );
        await blocker.query(
          "SELECT token_digest FROM rs_opaque_cursors WHERE scope_digest = $1 AND kind = 'changes_since' ORDER BY created_at, token_digest LIMIT 1 FOR UPDATE",
          [rsCursorDigest(SCOPE)]
        );
        let settled = false;
        issuing = issueRsCursor({
          context: CONTEXT,
          internalCursor: "visibility-probe",
          kind: "changes_since",
          now: NOW,
          scope: SCOPE,
        }).finally(() => {
          settled = true;
        });
        let blocked = false;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !blocked) {
          // biome-ignore lint/performance/noAwaitInLoops: each query polls a real lock wait until its bounded deadline.
          const state = await external.query<{ blocked: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND pid <> $1 AND wait_event_type = 'Lock') AS blocked",
            [blockerPid]
          );
          blocked = Boolean(state.rows[0]?.blocked);
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
        try {
          await blocker.query("ROLLBACK");
        } catch {
          /* already released */
        }
        if (issuing) {
          try {
            await issuing;
          } catch (error) {
            barrierError ??= error;
          }
        }
        blocker.release();
      }
      if (barrierError) {
        throw barrierError;
      }
      assert.equal(await count(), RS_CURSOR_QUOTA.changes_since);

      await external.query("DELETE FROM rs_opaque_cursors");
      await seed({ count: RS_CURSOR_QUOTA.changes_since });
      let maxObserved = 0;
      let observing = true;
      const observer = (async () => {
        const deadline = Date.now() + 30_000;
        while (observing && Date.now() < deadline) {
          // biome-ignore lint/performance/noAwaitInLoops: serial samples observe independent committed database states.
          maxObserved = Math.max(maxObserved, await count());
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(Date.now() < deadline, true);
      })();
      const batch = Promise.all(
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
      let issued: string[];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        issued = await Promise.race([
          batch,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("cursor concurrency oracle timed out")), 30_000);
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        observing = false;
      }
      await observer;
      assert.equal(issued.length, 300);
      assert.ok(maxObserved <= RS_CURSOR_QUOTA.changes_since);
      assert.ok((await count()) <= RS_CURSOR_QUOTA.changes_since);
      assert.equal(await count(), RS_CURSOR_QUOTA.changes_since);

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
  );
});
