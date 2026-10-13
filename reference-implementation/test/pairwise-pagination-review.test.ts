// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import pg from "pg";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb, withSqliteReadSnapshot } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import {
  invalidatePairwiseQuerySessionsPostgres,
  invalidatePairwiseQuerySessionsSqlite,
  loadPairwiseQueryState,
  savePairwiseQueryState,
  sweepPairwiseQuerySessions,
} from "../server/pairwise-query-sessions.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  PostgresStatementTimeoutError,
  postgresQuery,
  postgresQueryBounded,
  withPostgresReadSnapshot,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { referenceQueries } from "../server/queries/index.ts";
import {
  deleteConnectionRecordRowsPostgres,
  deleteConnectionRecordRowsSqlite,
  ingestRecord,
  queryRecordsAcrossBindings,
} from "../server/records.ts";
import { SqliteDriver } from "../server/sqlite-driver.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const ISSUER_KEY_INSERT = /INSERT INTO pairwise_query_issuer_key/;
const RESTART_SYNC_MESSAGE = /restart pagination.*original changes_since/;
const SAME_CHECKPOINT_RETRY_MESSAGE = /retry.*same checkpoint/;
const PLAIN_LIST_RESTART_MESSAGE = /restart a plain list without a cursor/;
const SESSION_CLEAR_SQL =
  /^(UPDATE pairwise_query_sessions SET state_json=|DELETE FROM pairwise_query_sessions WHERE token=)/;
const MUTATING_SESSION_SQL = /^(INSERT|UPDATE|DELETE|BEGIN|SELECT pg_advisory)/i;
const connectorId = "pairwise-pagination-review";
const stream = "items";
const manifest = {
  capabilities: { human_interaction: [] },
  connector_id: connectorId,
  display_name: "Pagination review",
  manifest_uri: `https://sources.example/${connectorId}`,
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: stream,
      primary_key: ["id"],
      schema: {
        properties: {
          id: { type: "string" },
          received_at: { format: "date-time", type: "string" },
          subject: { type: "string" },
        },
        required: ["id", "received_at", "subject"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};
const bindings = ["account_a", "account_b"].map((internalId, index) => ({
  connectorId,
  connectorInstanceId: internalId,
  instanceId: `inst_${index}`,
}));
const grant = {
  streams: [
    {
      fields: ["id", "received_at", "subject"],
      instance_ids: bindings.map((binding) => binding.connectorInstanceId),
      name: stream,
    },
  ],
};
const warning = {
  code: "deprecated_alias_used",
  message: "Use the canonical instance selector",
  param: "connector_instance_id",
};
type Backend = "SQLite" | "PostgreSQL";

async function withFixture(
  backend: Backend,
  run: (databaseUrl: string | null, attachment?: string) => Promise<void>,
  limits: Record<string, string> = {},
  sqliteMemory = false,
  encryptionKey?: string
): Promise<void> {
  const priorFlag = process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  const priorLimits = Object.fromEntries(Object.keys(limits).map((name) => [name, process.env[name]]));
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  Object.assign(process.env, limits);
  async function seedAndRun(databaseUrl: string | null, attachment?: string): Promise<void> {
    await registerConnector(manifest);
    const store =
      backend === "PostgreSQL" ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
    for (const [index, binding] of bindings.entries()) {
      const now = new Date().toISOString();
      // biome-ignore lint/performance/noAwaitInLoops: seed each account before its records and keep fixture writes deterministic.
      await store.upsert({
        connectorId,
        connectorInstanceId: binding.connectorInstanceId,
        createdAt: now,
        displayName: binding.connectorInstanceId,
        ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
        sourceBinding: { account: binding.connectorInstanceId },
        sourceBindingKey: binding.connectorInstanceId,
        sourceKind: "account",
        status: "active",
        updatedAt: now,
      });
      for (let item = 0; item < 2; item += 1) {
        const id = `${index}-${item}`;
        const receivedAt = `2026-05-0${index * 2 + item + 1}T12:00:00.000Z`;
        // biome-ignore lint/performance/noAwaitInLoops: sequential fixture writes preserve deterministic per-instance history.
        await ingestRecord(
          { connector_id: connectorId, connector_instance_id: binding.connectorInstanceId },
          {
            data: { id, received_at: receivedAt, subject: "retained payload".repeat(100) },
            emitted_at: receivedAt,
            key: id,
            stream,
          },
          { deferIndexes: true }
        );
      }
    }
    await run(databaseUrl, attachment);
  }
  try {
    if (backend === "PostgreSQL") {
      const connectionString = process.env.PDPP_TEST_POSTGRES_URL;
      assert.ok(connectionString);
      await withTemporaryPostgresDatabase(
        {
          closeConnections: closePostgresStorage,
          connectionString,
          databaseName: `pdpp_pairwise_review_${randomUUID().replaceAll("-", "")}`,
          templateName: null,
        },
        async (databaseUrl) => {
          await initPostgresStorage({ backend: "postgres", databaseUrl });
          const attachment = await createAlreadyAdmittedTestDatabaseChildAttachment(databaseUrl);
          await seedAndRun(databaseUrl, attachment);
        }
      );
    } else {
      if (sqliteMemory) {
        initDb();
        try {
          await seedAndRun(null);
        } finally {
          closeDb();
        }
        return;
      }
      const directory = mkdtempSync(join(tmpdir(), "pairwise-pagination-"));
      const databasePath = join(directory, "records.sqlite");
      initDb(
        databasePath,
        encryptionKey === undefined ? { busyTimeoutMs: 100 } : { busyTimeoutMs: 100, encryptionKey }
      );
      try {
        await seedAndRun(databasePath);
      } finally {
        closeDb();
        rmSync(directory, { force: true, recursive: true });
      }
    }
  } finally {
    if (priorFlag === undefined) {
      delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
    } else {
      process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = priorFlag;
    }
    for (const [name, value] of Object.entries(priorLimits)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function query(params: Parameters<typeof queryRecordsAcrossBindings>[3], selected = bindings) {
  return queryRecordsAcrossBindings(selected, stream, grant, params, manifest, { extraWarnings: [warning] });
}

async function retained(backend: Backend): Promise<{ bytes: number; rows: number; records: number }> {
  const rows =
    backend === "PostgreSQL"
      ? (await postgresQuery<{ state_json: string }>("SELECT state_json FROM pairwise_query_sessions")).rows
      : getDb().prepare("SELECT state_json FROM pairwise_query_sessions").all<{ state_json: string }>();
  return {
    bytes: rows.reduce((total, row) => total + Buffer.byteLength(row.state_json), 0),
    records: rows.reduce((total, row) => total + (JSON.parse(row.state_json).data?.length ?? 0), 0),
    rows: rows.length,
  };
}

function hasCode(error: unknown, expected: string): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === expected;
}

async function seedReadGrant(backend: Backend, grantId: string, status = "active"): Promise<void> {
  const values = [
    grantId,
    "review-subject",
    "review-client",
    JSON.stringify(grant),
    "recurring",
    status,
    new Date().toISOString(),
  ];
  if (backend === "PostgreSQL") {
    await postgresQuery(
      "INSERT INTO grants(grant_id,subject_id,client_id,grant_json,access_mode,status,issued_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      values
    );
  } else {
    getDb()
      .prepare(
        "INSERT INTO grants(grant_id,subject_id,client_id,grant_json,access_mode,status,issued_at) VALUES(?,?,?,?,?,?,?)"
      )
      .run(...values);
  }
}

function issuerBarrier(backend: Backend, context: TestContext, nth: number, erase: () => unknown) {
  const state = { fired: false };
  let calls = 0;
  const keySql = "SELECT key FROM pairwise_query_issuer_key WHERE id=1";
  if (backend === "SQLite") {
    const prototype = Object.getPrototypeOf(getDb().prepare(keySql)) as { get: (...args: unknown[]) => unknown };
    const original = prototype.get;
    context.mock.method(prototype, "get", function (this: { source?: string }, ...args: unknown[]) {
      if (this.source === keySql) {
        calls += 1;
      }
      if (this.source === keySql && calls === nth) {
        state.fired = true;
        erase();
      }
      return Reflect.apply(original, this, args);
    });
  } else {
    const pool = getPostgresPool();
    const original = pool.query.bind(pool);
    context.mock.method(pool, "query", async (sql: string, ...args: unknown[]) => {
      if (sql === keySql) {
        calls += 1;
      }
      if (sql === keySql && calls === nth) {
        state.fired = true;
        await erase();
      }
      return (original as (...args: unknown[]) => unknown)(sql, ...args);
    });
  }
  return state;
}

function eraseFixtureConnection(backend: Backend, id: string) {
  return backend === "SQLite"
    ? getDb()
        .transaction(() => deleteConnectionRecordRowsSqlite(id))
        .immediate()
    : withPostgresTransaction((client) => deleteConnectionRecordRowsPostgres(client, id));
}

for (const backend of ["SQLite", "PostgreSQL"] as const) {
  const options = {
    skip: backend === "PostgreSQL" && !process.env.PDPP_TEST_POSTGRES_URL ? "PDPP_TEST_POSTGRES_URL unset" : false,
  };
  for (const status of ["missing", "expired"]) {
    test(`${backend}: ${status} persisted grant cannot retain a snapshot`, options, async () => {
      await withFixture(backend, async () => {
        const actual = { ...grant, grant_id: "status-check" };
        if (status !== "missing") {
          await seedReadGrant(backend, actual.grant_id, status);
        }
        await assert.rejects(queryRecordsAcrossBindings(bindings, stream, actual, { limit: "1" }, manifest), (error) =>
          hasCode(error, "grant_revoked")
        );
        assert.deepEqual(await retained(backend), { bytes: 0, records: 0, rows: 0 });
      });
    });
  }

  for (const checkpointInput of [false, true]) {
    test(
      `${backend}: unrelated erasure preserves ${checkpointInput ? "a valid checkpoint" : "a tokenless list"}`,
      options,
      async (context) => {
        await withFixture(backend, async () => {
          const [binding] = bindings;
          assert.ok(binding);
          const checkpoint = checkpointInput
            ? (await query({ changes_since: "beginning", limit: "10" }, [binding])).next_changes_since
            : undefined;
          if (checkpointInput) {
            assert.ok(checkpoint);
          }
          const barrier = issuerBarrier(backend, context, checkpointInput ? 2 : 1, () =>
            eraseFixtureConnection(backend, "account_b")
          );
          await query(checkpointInput ? { changes_since: checkpoint, limit: "10" } : { limit: "1" }, [binding]);
          context.mock.restoreAll();
          assert.equal(barrier.fired, true);
        });
      }
    );
  }

  test(`${backend}: checkpoint history preserves the newest checkpoint of another context`, options, async () => {
    await withFixture(
      backend,
      async () => {
        const [binding] = bindings;
        assert.ok(binding);
        await seedReadGrant(backend, "shared-grant");
        const narrow = {
          ...grant,
          grant_id: "shared-grant",
          streams: [{ ...grant.streams[0], fields: ["id"], name: stream }],
        };
        const only = await queryRecordsAcrossBindings(
          [binding],
          stream,
          narrow,
          { changes_since: "beginning", limit: "10" },
          manifest
        );
        assert.ok(only.next_changes_since);
        let checkpoint = "beginning";
        for (let index = 0; index < 3; index += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: same context creates ordinary polling history.
          checkpoint = String((await query({ changes_since: checkpoint, limit: "10" }, [binding])).next_changes_since);
        }
        assert.ok(
          (
            await queryRecordsAcrossBindings(
              [binding],
              stream,
              narrow,
              { changes_since: only.next_changes_since, limit: "10" },
              manifest
            )
          ).next_changes_since
        );
      },
      { PDPP_PAIRWISE_QUERY_MAX_CHECKPOINTS: "3" }
    );
  });

  test(`${backend}: a grant cannot fill checkpoint retention by varying contexts`, options, async () => {
    await withFixture(
      backend,
      async () => {
        const [binding] = bindings;
        assert.ok(binding);
        await seedReadGrant(backend, "daily");
        await seedReadGrant(backend, "poller");
        const daily = { ...grant, grant_id: "daily" };
        const poller = { ...grant, grant_id: "poller" };
        const only = await queryRecordsAcrossBindings(
          [binding],
          stream,
          daily,
          { changes_since: "beginning", limit: "10" },
          manifest
        );
        assert.ok(only.next_changes_since);
        for (const fields of ["id", "received_at", "subject", "id,subject"]) {
          // biome-ignore lint/performance/noAwaitInLoops: one grant varies query context to exercise its shared quota.
          await queryRecordsAcrossBindings(
            [binding],
            stream,
            poller,
            { changes_since: "beginning", fields, limit: "10" },
            manifest
          );
        }
        assert.equal((await retained(backend)).rows, 4, "daily checkpoint plus at most three poller contexts");
        assert.ok(
          (
            await queryRecordsAcrossBindings(
              [binding],
              stream,
              daily,
              { changes_since: only.next_changes_since, limit: "10" },
              manifest
            )
          ).next_changes_since
        );
      },
      { PDPP_PAIRWISE_QUERY_MAX_CHECKPOINTS_PER_GRANT: "3" }
    );
  });

  test(`${backend}: terminal replay cannot renew quota-evicted checkpoint rights`, options, async () => {
    await withFixture(
      backend,
      async () => {
        const pending = await query({ changes_since: "beginning", limit: "1" });
        assert.ok(pending.next_cursor);
        const terminal = await query({ changes_since: "beginning", cursor: pending.next_cursor, limit: "10" });
        assert.ok(terminal.next_changes_since);
        assert.ok((await query({ changes_since: "beginning", limit: "10" })).next_changes_since);
        await assert.rejects(query({ changes_since: "beginning", cursor: pending.next_cursor, limit: "10" }), (error) =>
          hasCode(error, "invalid_cursor")
        );
      },
      { PDPP_PAIRWISE_QUERY_MAX_CHECKPOINTS: "1" }
    );
  });

  test(`${backend}: a later terminal issuance retains its freshly returned checkpoint`, options, async () => {
    await withFixture(
      backend,
      async () => {
        const pending = await query({ changes_since: "beginning", limit: "1" });
        assert.ok(pending.next_cursor);
        assert.ok((await query({ changes_since: "beginning", limit: "10" })).next_changes_since);
        const terminal = await query({ changes_since: "beginning", cursor: pending.next_cursor, limit: "10" });
        assert.ok(terminal.next_changes_since);
        assert.ok((await query({ changes_since: terminal.next_changes_since, limit: "10" })).next_changes_since);
      },
      { PDPP_PAIRWISE_QUERY_MAX_CHECKPOINTS: "1" }
    );
  });

  test(`${backend}: erased plain-list collection directs a restart without a page cursor`, options, async (context) => {
    await withFixture(backend, async () => {
      issuerBarrier(backend, context, 1, () => eraseFixtureConnection(backend, "account_a"));
      await assert.rejects(query({ limit: "1" }), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(hasCode(error, "query_capacity_exceeded"));
        assert.match(error.message, PLAIN_LIST_RESTART_MESSAGE);
        assert.doesNotMatch(error.message, SAME_CHECKPOINT_RETRY_MESSAGE);
        return true;
      });
      context.mock.restoreAll();
      assert.ok(await query({ limit: "1" }));
    });
  });

  for (const revoke of [false, true]) {
    test(
      `${backend}: terminal issuance cannot recreate a snapshot after ${revoke ? "grant revocation" : "source erasure"}`,
      options,
      async (context) => {
        await withFixture(backend, async () => {
          const actual = { ...grant, grant_id: "terminal-grant" };
          await seedReadGrant(backend, actual.grant_id);
          const read = (cursor?: string) =>
            queryRecordsAcrossBindings(
              bindings,
              stream,
              actual,
              {
                changes_since: "beginning",
                ...(cursor ? { cursor } : {}),
                limit: "1",
              },
              manifest
            );
          let page = await read();
          for (let index = 0; index < 2; index += 1) {
            assert.ok(page.next_cursor);
            // biome-ignore lint/performance/noAwaitInLoops: reach the cursor whose next page will issue the first checkpoint.
            page = await read(page.next_cursor);
          }
          assert.ok(page.next_cursor);
          const barrier = issuerBarrier(backend, context, 2, async () => {
            if (!revoke) {
              await eraseFixtureConnection(backend, bindings[0]?.connectorInstanceId ?? "");
            } else if (backend === "PostgreSQL") {
              await withPostgresTransaction(async (client) => {
                await invalidatePairwiseQuerySessionsPostgres({ grantId: actual.grant_id }, client);
                await client.query("UPDATE grants SET status='revoked' WHERE grant_id=$1", [actual.grant_id]);
              });
            } else {
              getDb()
                .transaction(() => {
                  invalidatePairwiseQuerySessionsSqlite({ grantId: actual.grant_id });
                  getDb().prepare("UPDATE grants SET status='revoked' WHERE grant_id=?").run(actual.grant_id);
                })
                .immediate();
            }
          });
          await assert.rejects(read(page.next_cursor), (error) => {
            assert.ok(error instanceof Error);
            assert.ok(hasCode(error, revoke ? "grant_revoked" : "query_capacity_exceeded"));
            if (!revoke) {
              assert.match(error.message, RESTART_SYNC_MESSAGE);
              assert.doesNotMatch(error.message, SAME_CHECKPOINT_RETRY_MESSAGE);
            }
            return true;
          });
          assert.equal(barrier.fired, true);
          assert.deepEqual(await retained(backend), { bytes: 0, records: 0, rows: 0 });
          if (!revoke) {
            context.mock.restoreAll();
            await assert.rejects(read(page.next_cursor), (error) => hasCode(error, "invalid_cursor"));
            assert.ok(await read());
          }
        });
      }
    );
  }

  test(`${backend}: maintenance applies a lowered checkpoint cap without waiting for expiry`, options, async () => {
    await withFixture(
      backend,
      async () => {
        for (let index = 0; index < 4; index += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: create separate issued checkpoint rows before lowering the cap.
          await query({ changes_since: "beginning", limit: "10" });
        }
        process.env.PDPP_PAIRWISE_QUERY_MAX_CHECKPOINTS = "3";
        await sweepPairwiseQuerySessions();
        assert.equal((await retained(backend)).rows, 3);
      },
      { PDPP_PAIRWISE_QUERY_MAX_CHECKPOINTS: "4" }
    );
  });

  test(
    `${backend}: issued terminal checkpoint survives page reclamation and terminal replay is read-only`,
    options,
    async (context) => {
      await withFixture(backend, async () => {
        context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        let page = await query({ changes_since: "beginning", limit: "1" });
        let terminalInput: string | undefined;
        while (page.next_cursor) {
          terminalInput = page.next_cursor;
          // biome-ignore lint/performance/noAwaitInLoops: follow the real multi-page terminal issuance path.
          page = await query({ changes_since: "beginning", cursor: terminalInput, limit: "1" });
        }
        assert.ok(page.next_changes_since);
        assert.ok(terminalInput);
        const assertReadOnly = (sql: string) => assert.doesNotMatch(sql, MUTATING_SESSION_SQL);
        if (backend === "PostgreSQL") {
          const pool = getPostgresPool();
          const original = pool.query.bind(pool);
          context.mock.method(pool, "query", (sql: string, ...args: unknown[]) => {
            assertReadOnly(sql);
            return (original as (...args: unknown[]) => unknown)(sql, ...args);
          });
        } else {
          const db = getDb();
          const original = db.prepare.bind(db);
          context.mock.method(db, "prepare", (sql: string) => {
            assertReadOnly(sql);
            return original(sql);
          });
        }
        assert.ok((await query({ changes_since: "beginning", cursor: terminalInput, limit: "1" })).next_changes_since);
        context.mock.restoreAll();
        context.mock.timers.tick(16 * 60 * 1000);
        await sweepPairwiseQuerySessions();
        assert.equal((await retained(backend)).records, 0);
        assert.ok((await query({ changes_since: page.next_changes_since, limit: "10" })).next_changes_since);
        context.mock.timers.reset();
      });
    }
  );

  test(`${backend}: abandoned changes pages do not retain never-issued checkpoints`, options, async (context) => {
    await withFixture(backend, async () => {
      context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      try {
        assert.ok((await query({ changes_since: "beginning", limit: "1" })).next_cursor);
        context.mock.timers.tick(16 * 60 * 1000);
        await sweepPairwiseQuerySessions();
        assert.deepEqual(await retained(backend), { bytes: 0, records: 0, rows: 0 });
      } finally {
        context.mock.timers.reset();
      }
    });
  });

  test(`${backend}: unrelated erasure keeps another instance's retained snapshot readable`, options, async () => {
    await withFixture(backend, async () => {
      const [binding] = bindings;
      assert.ok(binding);
      const first = await query({ limit: "1", order: "asc" }, [binding]);
      assert.ok(first.next_cursor);
      const before = await retained(backend);
      assert.equal(before.rows, 1);
      assert.equal(before.records, 2);
      await eraseFixtureConnection(backend, "account_b");
      assert.deepEqual(await retained(backend), before, "erasing another instance must not touch this snapshot");
      const second = await query({ cursor: first.next_cursor, limit: "1", order: "asc" }, [binding]);
      assert.deepEqual([...first.data, ...second.data].map((record) => record.id), ["0-0", "0-1"]);
    });
  });

  test(
    `${backend}: erasure between materialization and admission cannot resurrect retained payload`,
    options,
    async (context) => {
      await withFixture(backend, async () => {
        const [firstBinding, secondBinding] = bindings;
        assert.ok(firstBinding);
        assert.ok(secondBinding);
        const unrelated = await query({ limit: "1" }, [firstBinding]);
        assert.ok(unrelated.next_cursor);
        const before = await retained(backend);
        let erased = false;
        if (backend === "SQLite") {
          const db = getDb();
          const keySql = "SELECT key FROM pairwise_query_issuer_key WHERE id=1";
          const prototype = Object.getPrototypeOf(db.prepare(keySql)) as { get: (...args: unknown[]) => unknown };
          const original = prototype.get;
          context.mock.method(prototype, "get", function (this: { source?: string }, ...args: unknown[]) {
            if (!erased && this.source === keySql) {
              erased = true;
              db.transaction(() => deleteConnectionRecordRowsSqlite("account_b")).immediate();
            }
            return Reflect.apply(original, this, args);
          });
        } else {
          const pool = getPostgresPool();
          const original = pool.query.bind(pool);
          context.mock.method(pool, "query", async (sql: string, ...args: unknown[]) => {
            if (!erased && sql === "SELECT key FROM pairwise_query_issuer_key WHERE id=1") {
              erased = true;
              await withPostgresTransaction((client) => deleteConnectionRecordRowsPostgres(client, "account_b"));
            }
            return (original as (...args: unknown[]) => unknown)(sql, ...args);
          });
        }
        const outcome = await query({ changes_since: "beginning", limit: "1" }, [secondBinding]).then(
          () => "ok",
          (error) => error.code ?? String(error)
        );
        context.mock.restoreAll();
        assert.equal(
          erased,
          true,
          `barrier must commit erasure after reads and before locked admission; outcome=${outcome}`
        );
        assert.deepEqual(await retained(backend), before, "erased payload must not be inserted after lifecycle purge");
        assert.equal(outcome, "query_capacity_exceeded");
        assert.equal((await query({ cursor: unrelated.next_cursor, limit: "1" }, [firstBinding])).data.length, 1);
      });
    }
  );

  test(`${backend}: completed checkpoints do not exhaust active snapshot capacity`, options, async () => {
    await withFixture(
      backend,
      async () => {
        let checkpoint = "beginning";
        for (let index = 0; index < 3; index += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: each incremental poll consumes the prior checkpoint.
          const result = await query({ changes_since: checkpoint, limit: "10" });
          checkpoint = String(result.next_changes_since);
        }
        const narrower = { streams: [{ ...grant.streams[0], fields: ["id"], name: stream }] };
        const other = await queryRecordsAcrossBindings(bindings, stream, narrower, { limit: "1" }, manifest);
        assert.ok(other.next_cursor, "another context must retain active page capacity");
        assert.ok((await query({ changes_since: checkpoint, limit: "10" })).next_changes_since);
      },
      { PDPP_PAIRWISE_QUERY_MAX_SESSIONS: "3" }
    );
  });

  test(`${backend}: bounded checkpoint history expires the oldest context checkpoint`, options, async () => {
    await withFixture(
      backend,
      async () => {
        let checkpoint = "beginning";
        let oldest = "";
        for (let index = 0; index < 4; index += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: each incremental poll consumes the prior checkpoint.
          const result = await query({ changes_since: checkpoint, limit: "10" });
          checkpoint = String(result.next_changes_since);
          if (index === 0) {
            oldest = checkpoint;
          }
        }
        await assert.rejects(query({ changes_since: oldest, limit: "10" }), (error) =>
          hasCode(error, "cursor_expired")
        );
        assert.ok((await query({ changes_since: checkpoint, limit: "10" })).next_changes_since);
        assert.equal((await retained(backend)).rows, 3);
      },
      { PDPP_PAIRWISE_QUERY_MAX_CHECKPOINTS_PER_CONTEXT: "3" }
    );
  });

  test(`${backend}: checkpoint token size stays bounded across successive polls`, options, async () => {
    await withFixture(backend, async () => {
      let checkpoint = "beginning";
      let initialBytes = 0;
      for (let index = 0; index < 5; index += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: reproduces ordinary incremental checkpoint chaining.
        checkpoint = String((await query({ changes_since: checkpoint, limit: "10" })).next_changes_since);
        if (index === 0) {
          initialBytes = checkpoint.length;
        }
      }
      assert.ok(checkpoint.length <= initialBytes + 16, "a checkpoint must not embed earlier checkpoints recursively");
    });
  });

  test(`${backend}: page and checkpoint tokens reveal no readable position or time`, options, async () => {
    await withFixture(backend, async () => {
      const page = await query({ limit: "1" });
      const checkpoint = await query({ changes_since: "beginning", limit: "10" });
      for (const token of [page.next_cursor, checkpoint.next_changes_since]) {
        assert.ok(token);
        for (const segment of token.split(".")) {
          const decoded = Buffer.from(segment, "base64url").toString();
          assert.throws(() => JSON.parse(decoded), "no token segment may expose plaintext JSON");
        }
      }
    });
  });

  test(`${backend}: authenticated checkpoint with missing retained state is cursor_expired`, options, async () => {
    await withFixture(backend, async () => {
      const checkpoint = (await query({ changes_since: "beginning", limit: "10" })).next_changes_since;
      assert.ok(checkpoint);
      if (backend === "PostgreSQL") {
        await postgresQuery("DELETE FROM pairwise_query_sessions");
      } else {
        getDb().prepare("DELETE FROM pairwise_query_sessions").run();
      }
      await assert.rejects(query({ changes_since: checkpoint, limit: "10" }), (error) =>
        hasCode(error, "cursor_expired")
      );
    });
  });

  test(
    `${backend}: following a page cursor reads the existing issuer key without a write`,
    options,
    async (context) => {
      await withFixture(backend, async (databasePath) => {
        const page = await query({ limit: "1" });
        assert.ok(page.next_cursor);
        if (backend === "SQLite") {
          assert.ok(databasePath);
          const writer = new SqliteDriver(databasePath, { timeout: 100 });
          writer.exec("BEGIN IMMEDIATE");
          try {
            assert.ok((await query({ cursor: page.next_cursor, limit: "1" })).data.length);
          } finally {
            writer.exec("ROLLBACK");
            writer.close();
          }
        } else {
          const pool = getPostgresPool();
          const original = pool.query.bind(pool);
          context.mock.method(pool, "query", (sql: string, ...args: unknown[]) => {
            assert.doesNotMatch(String(sql), ISSUER_KEY_INSERT);
            return (original as (...args: unknown[]) => unknown)(sql, ...args);
          });
          assert.ok((await query({ cursor: page.next_cursor, limit: "1" })).data.length);
          context.mock.restoreAll();
        }
      });
    }
  );

  for (const memory of backend === "SQLite" ? [false, true] : [false]) {
    test(
      `${backend}${memory ? " memory" : ""}: pairwise changes use one horizon across an atomic two-instance mutation`,
      options,
      async (context) => {
        await withFixture(
          backend,
          async (databaseUrl) => {
            let barrierSeen = false;
            const statementSql = referenceQueries.recordsSnapshotsGetSnapshotAtVersion.sql;
            let sqliteWriter: ReturnType<typeof getDb> | null = null;
            if (backend === "SQLite") {
              sqliteWriter = databaseUrl
                ? (new SqliteDriver(databaseUrl, { timeout: 1000 }) as unknown as ReturnType<typeof getDb>)
                : getDb();
            }
            const postgresWriter =
              backend === "PostgreSQL" ? new pg.Client({ connectionString: databaseUrl ?? undefined }) : null;
            await postgresWriter?.connect();
            const mutateSqlite = () => {
              assert.ok(sqliteWriter);
              sqliteWriter
                .transaction(() => {
                  sqliteWriter.exec(`INSERT INTO record_changes(connector_id,connector_instance_id,stream,record_key,version,record_json,emitted_at,deleted)
              SELECT connector_id,connector_instance_id,stream,record_key,3,json_set(record_json,'$.subject','atomic update'),emitted_at,deleted
              FROM records WHERE record_key IN ('0-1','1-1')`);
                  sqliteWriter.exec(
                    `UPDATE records SET record_json=json_set(record_json,'$.subject','atomic update'),version=3 WHERE record_key IN ('0-1','1-1')`
                  );
                  sqliteWriter.exec("UPDATE version_counter SET max_version=3");
                })
                .immediate();
            };
            const mutatePostgres = async () => {
              assert.ok(postgresWriter);
              await postgresWriter.query("BEGIN");
              try {
                await postgresWriter.query(`INSERT INTO record_changes(connector_id,connector_instance_id,stream,record_key,version,record_json,emitted_at,deleted)
                  SELECT connector_id,connector_instance_id,stream,record_key,3,jsonb_set(record_json::jsonb,'{subject}','"atomic update"'),emitted_at,deleted
              FROM records WHERE record_key IN ('0-1','1-1')`);
                await postgresWriter.query(
                  `UPDATE records SET record_json=jsonb_set(record_json::jsonb,'{subject}','"atomic update"'),version=3 WHERE record_key IN ('0-1','1-1')`
                );
                await postgresWriter.query("UPDATE version_counter SET max_version=3");
                await postgresWriter.query("COMMIT");
              } catch (error) {
                await postgresWriter.query("ROLLBACK");
                throw error;
              }
            };
            if (sqliteWriter) {
              const prototype = Object.getPrototypeOf(getDb().prepare(statementSql)) as {
                get: (...values: unknown[]) => unknown;
              };
              const original = prototype.get;
              context.mock.method(prototype, "get", function (this: { source?: string }, ...values: unknown[]) {
                const result = Reflect.apply(original, this, values);
                if (
                  !barrierSeen &&
                  this.source === statementSql &&
                  values[0] === "account_a" &&
                  values[2] === "0-1" &&
                  values[3] === 2
                ) {
                  barrierSeen = true;
                  mutateSqlite();
                }
                return result;
              });
            } else {
              const prototype = pg.Client.prototype as unknown as { query: (...values: unknown[]) => unknown };
              const original = prototype.query;
              context.mock.method(prototype, "query", function (this: unknown, ...values: unknown[]) {
                const [sql, params] = values;
                const matches =
                  !barrierSeen &&
                  typeof sql === "string" &&
                  sql.includes("FROM record_changes") &&
                  sql.includes("version <= $4") &&
                  Array.isArray(params) &&
                  params[0] === "account_a" &&
                  params[2] === "0-1" &&
                  params[3] === 2;
                if (!matches) {
                  return Reflect.apply(original, this, values);
                }
                barrierSeen = true;
                const callback = values.at(-1);
                if (typeof callback === "function") {
                  values[values.length - 1] = (error: unknown, result: unknown) => {
                    if (error) {
                      Reflect.apply(callback, undefined, [error, result]);
                      return;
                    }
                    mutatePostgres().then(
                      () => Reflect.apply(callback, undefined, [null, result]),
                      (failure) => Reflect.apply(callback, undefined, [failure])
                    );
                  };
                  return Reflect.apply(original, this, values);
                }
                return (Reflect.apply(original, this, values) as Promise<unknown>).then(async (result) => {
                  await mutatePostgres();
                  return result;
                });
              });
            }
            try {
              const first = await query({ changes_since: "beginning", limit: "10", order: "asc" });
              assert.ok(barrierSeen, "the writer barrier must execute after A's horizon read");
              const pair = first.data.filter((record) => record.id === "0-1" || record.id === "1-1");
              assert.deepEqual(
                pair.map((record) => record.data?.subject),
                ["retained payload".repeat(100), "retained payload".repeat(100)],
                "an atomic write cannot yield A before the write and B after it"
              );
              assert.ok(first.next_changes_since);
              const next = await query({ changes_since: first.next_changes_since, limit: "10", order: "asc" });
              assert.deepEqual(
                next.data.map((record) => [record.id, record.data?.subject]),
                [
                  ["0-1", "atomic update"],
                  ["1-1", "atomic update"],
                ]
              );
            } finally {
              context.mock.restoreAll();
              if (sqliteWriter && databaseUrl) {
                sqliteWriter.close();
              }
              await postgresWriter?.end();
            }
          },
          {},
          memory
        );
      }
    );
  }
  for (const mutation of ["remove", "add", "change"] as const) {
    test(`${backend}: pairwise cursor rejects ${mutation} of changes_since context`, options, async () => {
      await withFixture(backend, async () => {
        const firstParams = mutation === "add" ? {} : { changes_since: "beginning" };
        const first = await query({ ...firstParams, limit: "1", order: "asc" });
        assert.ok(first.next_cursor);
        const changed =
          mutation === "remove" ? {} : { changes_since: mutation === "add" ? "beginning" : "other-checkpoint" };
        await assert.rejects(query({ ...changed, cursor: first.next_cursor, limit: "1", order: "asc" }), (error) =>
          hasCode(error, "invalid_cursor")
        );
      });
    });
  }

  // changes_since is bound twice: in the AEAD-sealed token (checked by loadPairwiseQueryState) and in the stored
  // page state (checked by requirePairwiseListState). The end-to-end loop above cannot tell which layer rejected,
  // so each layer gets a test that the other layer cannot satisfy.
  test(`${backend}: token layer rejects a changes_since the token was not issued for`, options, async () => {
    await withFixture(backend, async () => {
      const token = await savePairwiseQueryState({
        changes_since: "cp-a",
        context: "unit-context",
        data: [],
        kind: "page",
        offset: 0,
        retention: { generations: {}, grantDigest: "", grantId: "", scopes: [] },
      });
      for (const changesSince of ["cp-b", undefined]) {
        await assert.rejects(
          loadPairwiseQueryState(token, { changesSince, context: "unit-context", kind: "page" }),
          (error) => hasCode(error, "invalid_cursor")
        );
      }
      assert.ok(await loadPairwiseQueryState(token, { changesSince: "cp-a", context: "unit-context", kind: "page" }));
    });
  });

  test(`${backend}: stored-state layer rejects a changes_since the sealed token still matches`, options, async () => {
    await withFixture(backend, async () => {
      const params = { changes_since: "beginning", limit: "1", order: "asc" } as const;
      const first = await query(params);
      assert.ok(first.next_cursor);
      const sessionsSql = "SELECT token,state_json FROM pairwise_query_sessions";
      const rows =
        backend === "PostgreSQL"
          ? (await postgresQuery<{ state_json: string; token: string }>(sessionsSql)).rows
          : getDb().prepare(sessionsSql).all<{ state_json: string; token: string }>();
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.ok(row);
      const stored = JSON.parse(row.state_json);
      assert.equal(stored.changes_since, "beginning");
      const tampered = JSON.stringify({ ...stored, changes_since: "other-checkpoint" });
      if (backend === "PostgreSQL") {
        await postgresQuery("UPDATE pairwise_query_sessions SET state_json=$1 WHERE token=$2", [tampered, row.token]);
      } else {
        getDb().prepare("UPDATE pairwise_query_sessions SET state_json=? WHERE token=?").run(tampered, row.token);
      }
      await assert.rejects(query({ ...params, cursor: first.next_cursor }), (error) =>
        hasCode(error, "invalid_cursor")
      );
    });
  });

  test(`${backend}: pairwise scan retains one immutable snapshot and linear payload bytes`, options, async () => {
    await withFixture(backend, async () => {
      let page = await query({ limit: "1", order: "asc" });
      assert.ok(page.next_cursor, "a four-record scan at limit 1 must paginate");
      const seen = page.data.map((record) => record.id);
      const firstStorage = await retained(backend);
      assert.equal(firstStorage.records, 4);
      while (page.next_cursor) {
        // biome-ignore lint/performance/noAwaitInLoops: the next request depends on the preceding page cursor.
        page = await query({ cursor: page.next_cursor, limit: "1", order: "asc" });
        seen.push(...page.data.map((record) => record.id));
      }
      assert.deepEqual(seen, ["0-0", "0-1", "1-0", "1-1"]);
      const after = await retained(backend);
      assert.deepEqual(after, firstStorage, "paging must not duplicate snapshot rows, record copies or JSON bytes");
    });
  });

  test(
    `${backend}: pairwise cursor replay is deterministic and does not retain another snapshot`,
    options,
    async () => {
      await withFixture(backend, async () => {
        const first = await query({ limit: "1", order: "asc" });
        assert.ok(first.next_cursor);
        const before = await retained(backend);
        const next = await query({ cursor: first.next_cursor, limit: "1", order: "asc" });
        const retry = await query({ cursor: first.next_cursor, limit: "1", order: "asc" });
        assert.deepEqual(retry.data, next.data);
        assert.deepEqual(await retained(backend), before, "replay must not insert another full snapshot");
        assert.ok(retry.next_cursor);
        assert.ok(next.next_cursor);
        assert.deepEqual(
          (await query({ cursor: retry.next_cursor, limit: "1", order: "asc" })).data,
          (await query({ cursor: next.next_cursor, limit: "1", order: "asc" })).data,
          "both replay continuations must resolve to the same next page"
        );
      });
    }
  );

  test(`${backend}: expired pairwise changes checkpoint returns cursor_expired`, options, async (context) => {
    await withFixture(backend, async () => {
      context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      try {
        const first = await query({ changes_since: "beginning", limit: "10", order: "asc" });
        assert.ok(first.next_changes_since);
        context.mock.timers.tick(31 * 24 * 60 * 60 * 1000);
        await assert.rejects(query({ changes_since: first.next_changes_since, order: "asc" }), (error) =>
          hasCode(error, "cursor_expired")
        );
      } finally {
        context.mock.timers.reset();
      }
    });
  });

  test(`${backend}: expired checkpoint under another grant rejects context before expiry`, options, async (context) => {
    await withFixture(backend, async () => {
      context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      try {
        const first = await query({ changes_since: "beginning", limit: "10", order: "asc" });
        assert.ok(first.next_changes_since);
        context.mock.timers.tick(31 * 24 * 60 * 60 * 1000);
        const narrower = { streams: [{ ...grant.streams[0], fields: ["id"], name: stream }] };
        await assert.rejects(
          queryRecordsAcrossBindings(
            bindings,
            stream,
            narrower,
            { changes_since: first.next_changes_since, order: "asc" },
            manifest
          ),
          (error) => hasCode(error, "invalid_cursor")
        );
      } finally {
        context.mock.timers.reset();
      }
    });
  });

  test(
    `${backend}: expired page lookup releases snapshot bytes without retaining an unissued checkpoint`,
    options,
    async (context) => {
      await withFixture(backend, async () => {
        context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        try {
          const first = await query({ changes_since: "beginning", limit: "1", order: "asc" });
          assert.ok(first.next_cursor);
          context.mock.timers.tick(16 * 60 * 1000);
          await assert.rejects(
            query({ changes_since: "beginning", cursor: first.next_cursor, limit: "1", order: "asc" }),
            (error) => hasCode(error, "invalid_cursor")
          );
          const after = await retained(backend);
          assert.equal(after.records, 0, "expired page data must be reclaimed on lookup");
          assert.equal(after.rows, 0, "a checkpoint was never issued for this abandoned session");
        } finally {
          context.mock.timers.reset();
        }
      });
    }
  );

  test(`${backend}: expired pairwise page returns invalid_cursor`, options, async (context) => {
    await withFixture(backend, async () => {
      context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      try {
        const first = await query({ limit: "1", order: "asc" });
        assert.ok(first.next_cursor);
        context.mock.timers.tick(31 * 24 * 60 * 60 * 1000);
        await assert.rejects(query({ cursor: first.next_cursor, limit: "1", order: "asc" }), (error) =>
          hasCode(error, "invalid_cursor")
        );
      } finally {
        context.mock.timers.reset();
      }
    });
  });

  test(`${backend}: pairwise page cursor survives reopen and rejects tampering`, options, async () => {
    await withFixture(backend, async (databaseUrl, attachment) => {
      const first = await query({ limit: "1", order: "asc" });
      assert.ok(first.next_cursor);
      const tampered = `${first.next_cursor.slice(0, 5)}${first.next_cursor[5] === "a" ? "b" : "a"}${first.next_cursor.slice(6)}`;
      await assert.rejects(query({ cursor: tampered, limit: "1", order: "asc" }), (error) =>
        hasCode(error, "invalid_cursor")
      );
      const before = await query({ cursor: first.next_cursor, limit: "1", order: "asc" });
      if (backend === "PostgreSQL") {
        assert.ok(databaseUrl);
        await closePostgresStorage();
        assert.ok(attachment);
        await initPostgresStorage(
          { backend: "postgres", databaseUrl },
          { testOnlyAlreadyAdmittedChildAttachment: attachment }
        );
      } else {
        closeDb();
        assert.ok(databaseUrl);
        initDb(databaseUrl);
      }
      const after = await query({ cursor: first.next_cursor, limit: "1", order: "asc" });
      assert.deepEqual(after.data, before.data);
      assert.ok(after.next_cursor);
      assert.ok(before.next_cursor);
      assert.deepEqual(
        (await query({ cursor: after.next_cursor, limit: "1", order: "asc" })).data,
        (await query({ cursor: before.next_cursor, limit: "1", order: "asc" })).data
      );
    });
  });

  test(`${backend}: concurrent pairwise admissions cannot exceed session quota`, options, async () => {
    await withFixture(
      backend,
      async () => {
        const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () => query({ limit: "1", order: "asc" })));
        assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
        assert.equal((await retained(backend)).rows, 1);
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            assert.ok(hasCode(outcome.reason, "query_capacity_exceeded"));
          }
        }
      },
      { PDPP_PAIRWISE_QUERY_MAX_SESSIONS: "1" }
    );
  });

  test(`${backend}: flagged list preserves the caller limit_clamped warning`, options, async () => {
    await withFixture(backend, async () => {
      const page = await query({ limit: "1000", order: "asc" });
      assert.ok(
        page.meta?.warnings?.some(
          (entry) => hasCode(entry, "limit_clamped") && "param" in entry && entry.param === "limit"
        )
      );
    });
  });

  test(`${backend}: resolver warnings survive continuation without repeated resolver input`, options, async () => {
    await withFixture(backend, async () => {
      const first = await query({ limit: "1", order: "asc" });
      assert.ok(first.next_cursor);
      const next = await queryRecordsAcrossBindings(
        bindings,
        stream,
        grant,
        { cursor: first.next_cursor, limit: "1", order: "asc" },
        manifest
      );
      assert.deepEqual(next.meta?.warnings, [warning]);
    });
  });

  for (const [name, value] of [
    ["PDPP_PAIRWISE_QUERY_MAX_SESSIONS", "1"],
    ["PDPP_PAIRWISE_QUERY_MAX_BYTES", "10240"],
  ] as const) {
    test(`${backend}: pairwise session admission enforces ${name}`, options, async () => {
      await withFixture(
        backend,
        async () => {
          await query({ limit: "1", order: "asc" });
          const firstStorage = await retained(backend);
          await assert.rejects(query({ limit: "1", order: "asc" }), (error) =>
            hasCode(error, "query_capacity_exceeded")
          );
          assert.deepEqual(await retained(backend), firstStorage, "a rejected session must not evict a live snapshot");
        },
        { [name]: value }
      );
    });
  }

  test(`${backend}: oversized pairwise snapshot has a permanent resource limit`, options, async () => {
    await withFixture(
      backend,
      async () => {
        await assert.rejects(query({ limit: "1", order: "asc" }), (error) => hasCode(error, "resource_limit"));
        assert.deepEqual(await retained(backend), { bytes: 0, records: 0, rows: 0 });
      },
      { PDPP_PAIRWISE_QUERY_MAX_SNAPSHOT_BYTES: "1024" }
    );
  });

  test(`${backend}: fresh pairwise session reclaims expired state`, options, async (context) => {
    await withFixture(backend, async () => {
      context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      try {
        const first = await query({ limit: "1", order: "asc" });
        assert.ok(first.next_cursor);
        context.mock.timers.tick(31 * 24 * 60 * 60 * 1000);
        await query({ limit: "1", order: "asc" });
        const current = await retained(backend);
        assert.equal(current.rows, 1, "the expired snapshot must be removed before fresh admission");
        await assert.rejects(query({ cursor: first.next_cursor, limit: "1", order: "asc" }), (error) =>
          hasCode(error, "invalid_cursor")
        );
      } finally {
        context.mock.timers.reset();
      }
    });
  });

  for (const size of [1, 2]) {
    for (const field of ["count", "window", "warnings"] as const) {
      test(`${backend}: flagged ${size}-instance list preserves requested ${field} across pages`, options, async () => {
        await withFixture(backend, async () => {
          const selected = bindings.slice(0, size);
          const params = { count: "exact", limit: "1", order: "asc", window: "exact" };
          const first = await query(params, selected);
          assert.ok(first.next_cursor);
          const next = await query({ ...params, cursor: first.next_cursor }, selected);
          for (const page of [first, next]) {
            if (field === "count") {
              assert.deepEqual(page.meta?.count, { kind: "exact", value: size * 2 });
            }
            if (field === "window") {
              assert.deepEqual(page.meta?.window, {
                earliest_at: "2026-05-01T12:00:00.000Z",
                latest_at: `2026-05-0${size * 2}T12:00:00.000Z`,
                total: size * 2,
              });
            }
            if (field === "warnings") {
              assert.deepEqual(page.meta?.warnings, [warning]);
            }
          }
        });
      });
    }
  }
}

for (const beforeCapture of [true, false]) {
  test(`SQLite: actual grant revoked ${beforeCapture ? "before" : "after"} snapshot capture cannot retain payload`, async (context) => {
    await withFixture("SQLite", async () => {
      const grantId = "revocation-barrier";
      await seedReadGrant("SQLite", grantId);
      const db = getDb();
      const outsideSnapshot = new AsyncResource("pairwise-review-revoke");
      let fired = false;
      const revoke = () =>
        outsideSnapshot.runInAsyncScope(() =>
          db
            .transaction(() => {
              fired = true;
              invalidatePairwiseQuerySessionsSqlite({ grantId });
              db.prepare("UPDATE grants SET status='revoked' WHERE grant_id=?").run(grantId);
            })
            .immediate()
        );
      if (beforeCapture) {
        const key = "SELECT scope_key,generation FROM pairwise_query_scope_epochs WHERE scope_key";
        const prototype = Object.getPrototypeOf(db.prepare("SELECT 1")) as { all: (...args: unknown[]) => unknown };
        const original = prototype.all;
        context.mock.method(prototype, "all", function (this: { source?: string }, ...args: unknown[]) {
          if (!fired && this.source?.startsWith(key)) {
            revoke();
          }
          return Reflect.apply(original, this, args);
        });
      } else {
        issuerBarrier("SQLite", context, 1, revoke);
      }
      await assert.rejects(
        queryRecordsAcrossBindings(bindings, stream, { ...grant, grant_id: grantId }, { limit: "1" }, manifest),
        (error) => hasCode(error, "grant_revoked")
      );
      context.mock.restoreAll();
      outsideSnapshot.emitDestroy();
      assert.equal(fired, true);
      assert.deepEqual(await retained("SQLite"), { bytes: 0, records: 0, rows: 0 });
    });
  });
}

test("SQLite: encrypted snapshot reader uses the key resolved at initialization", async () => {
  await withFixture(
    "SQLite",
    async () => {
      const priorKey = process.env.PDPP_DATABASE_ENCRYPTION_KEY;
      process.env.PDPP_DATABASE_ENCRYPTION_KEY = "different-test-only-key";
      try {
        const result = await query({ limit: "1", order: "asc" });
        assert.equal(result.data.length, 1);
        assert.ok(result.next_cursor);
      } finally {
        if (priorKey === undefined) {
          delete process.env.PDPP_DATABASE_ENCRYPTION_KEY;
        } else {
          process.env.PDPP_DATABASE_ENCRYPTION_KEY = priorKey;
        }
      }
    },
    {},
    false,
    "snapshot-test-only-key"
  );
});

test("SQLite: oversized memory snapshot refuses before serialization", async (context) => {
  await withFixture(
    "SQLite",
    async () => {
      const prototype = Object.getPrototypeOf(getDb()) as {
        pragma: (...values: unknown[]) => unknown;
        serialize: () => Buffer;
      };
      const originalPragma = prototype.pragma;
      context.mock.method(prototype, "pragma", function (this: unknown, ...values: unknown[]) {
        if (values[0] === "page_count") {
          return 16_385;
        }
        if (values[0] === "page_size") {
          return 4096;
        }
        return Reflect.apply(originalPragma, this, values);
      });
      const serialized = context.mock.method(prototype, "serialize");
      try {
        await assert.rejects(
          withSqliteReadSnapshot(async () => 1),
          (error) => hasCode(error, "resource_limit")
        );
        assert.equal(serialized.mock.callCount(), 0);
      } finally {
        context.mock.restoreAll();
      }
    },
    {},
    true
  );
});

test("PostgreSQL: bounded snapshot reads retain statement timeout classification", {
  skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withFixture("PostgreSQL", async () => {
    await assert.rejects(
      withPostgresReadSnapshot(() => postgresQueryBounded("SELECT pg_sleep(0.1)", [], 10)),
      PostgresStatementTimeoutError
    );
  });
});

test("PostgreSQL: first scope registration waits for an uncommitted connection erasure", {
  skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (context) => {
  await withFixture("PostgreSQL", async (databaseUrl) => {
    assert.ok(databaseUrl);
    const [binding] = bindings;
    assert.ok(binding);
    await postgresQuery("DELETE FROM pairwise_query_scope_epochs");
    const writer = new pg.Client({ connectionString: databaseUrl });
    const observer = new pg.Client({ connectionString: databaseUrl });
    await writer.connect();
    await observer.connect();
    let committed = false;
    let sawRegistrationLock = false;
    const commit = async () => {
      if (!committed) {
        committed = true;
        await writer.query("COMMIT");
      }
    };
    try {
      await writer.query("BEGIN");
      await deleteConnectionRecordRowsPostgres(writer, binding.connectorInstanceId);
      issuerBarrier("PostgreSQL", context, 1, commit);
      const resultPromise = query({ limit: "1" }, [binding]);
      for (let attempt = 0; !committed && attempt < 1000; attempt += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: observe an actual database lock without a timing sleep.
        const blocked = await observer.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO pairwise_query_scope_epochs%' LIMIT 1"
        );
        if (blocked.rows.length) {
          sawRegistrationLock = true;
          await commit();
        }
      }
      if (!committed) {
        await commit();
      }
      const result = await resultPromise;
      assert.equal(result.data.length, 0, "a first query must not retain the pre-erasure records");
      assert.equal(sawRegistrationLock, true, "scope registration must wait for the source transaction");
      assert.deepEqual(await retained("PostgreSQL"), { bytes: 0, records: 0, rows: 0 });
    } finally {
      context.mock.restoreAll();
      await writer.query("ROLLBACK");
      await writer.end();
      await observer.end();
    }
  });
});

for (const firstWaiter of ["none", "ingest"] as const) {
  test(`PostgreSQL: ${firstWaiter} waits first during tombstone ingest and maintenance clearing expired pages`, {
    skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
  }, async (context) => {
    await withFixture("PostgreSQL", async (databaseUrl) => {
      assert.ok(databaseUrl);
      assert.ok((await query({ limit: "1" })).next_cursor);
      assert.ok((await query({ limit: "1", order: "desc" })).next_cursor);
      const eraseOrder = (
        await postgresQuery<{ token: string }>(
          "SELECT token FROM pairwise_query_sessions WHERE page_expires_at>0 AND token IN (SELECT token FROM pairwise_query_session_scopes WHERE connector_instance_id=$1 AND stream=$2)",
          ["account_a", stream]
        )
      ).rows.map((row) => row.token);
      assert.equal(eraseOrder.length, 2);
      const future = Date.now() + 10 ** 9;
      await postgresQuery("UPDATE pairwise_query_sessions SET page_expires_at=1,expires_at=$2 WHERE token=$1", [
        eraseOrder[0],
        future + 1000,
      ]);
      await postgresQuery("UPDATE pairwise_query_sessions SET page_expires_at=1,expires_at=$2 WHERE token=$1", [
        eraseOrder[1],
        future,
      ]);
      const observer = new pg.Client({ connectionString: databaseUrl });
      await observer.connect();
      const arrived: { token: string; pid: number }[] = [];
      const seen = new WeakSet<object>();
      let serialized = false;
      const blocked = () =>
        observer.query<{ pid: number; query: string }>(
          "SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pairwise_query_sessions%'"
        );
      const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
      const original = prototype.query;
      context.mock.method(prototype, "query", function (this: { processID: number }, sql: unknown, ...args: unknown[]) {
        const result = Reflect.apply(original, this, [sql, ...args]);
        if (typeof sql === "string" && SESSION_CLEAR_SQL.test(sql) && !seen.has(this) && result instanceof Promise) {
          seen.add(this);
          return result.then(async (value) => {
            const token = String((args[0] as unknown[]).at(-1));
            arrived.push({ pid: this.processID, token });
            const deadline = Date.now() + 1500;
            while (arrived.length < 2 && !serialized) {
              assert.ok(
                Date.now() < deadline,
                "barrier must observe a second clear or an actual ordered row-lock waiter"
              );
              // biome-ignore lint/performance/noAwaitInLoops: observe the database lock barrier without timing sleeps.
              const waiting = await blocked();
              serialized = waiting.rows.some(
                (row) => row.pid !== this.processID && row.query.endsWith("ORDER BY token FOR UPDATE")
              );
            }
            if (!serialized && firstWaiter === "ingest" && token === eraseOrder[1]) {
              const ingestPid = arrived.find((row) => row.token === eraseOrder[0])?.pid;
              let ingestWaiting = false;
              while (!ingestWaiting) {
                assert.ok(Date.now() < deadline, "ingest must reach the opposing row lock before sweep continues");
                // biome-ignore lint/performance/noAwaitInLoops: choose the deadlock victim through an actual wait-state barrier.
                const waiting = await blocked();
                ingestWaiting = waiting.rows.some((row) => row.pid === ingestPid);
              }
            }
            return value;
          });
        }
        return result;
      });
      try {
        const outcomes = await Promise.allSettled([
          ingestRecord(
            { connector_id: connectorId, connector_instance_id: "account_a" },
            { data: {}, key: "0-0", op: "delete", stream }
          ),
          sweepPairwiseQuerySessions(),
        ]);
        for (const outcome of outcomes) {
          assert.equal(
            outcome.status,
            "fulfilled",
            outcome.status === "rejected" ? (outcome.reason as Error).message : ""
          );
        }
        assert.equal(serialized, true, "one transaction must wait at the ordered row fence before clearing rows");
        const records = (
          await postgresQuery<{ count: string }>(
            "SELECT COUNT(*) AS count FROM records WHERE connector_instance_id=$1 AND stream=$2 AND record_key=$3 AND NOT deleted",
            ["account_a", stream, "0-0"]
          )
        ).rows;
        assert.equal(Number(records[0]?.count), 0, "actual tombstone must commit source deletion");
        assert.equal((await retained("PostgreSQL")).rows, 0);
      } finally {
        context.mock.restoreAll();
        await observer.end();
      }
    });
  });
}
