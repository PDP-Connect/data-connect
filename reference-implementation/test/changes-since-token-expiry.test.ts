// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A bulk stream reset reissues versions from 1, so a `changes_since` token (or
 * a page cursor of a changes session) minted before the reset must not be
 * replayed against the new version space. Tokens carry the connection's
 * `record_reset_generation`; a mismatch is 410 `cursor_expired` and the client
 * re-syncs from `beginning` (spec-core.md "changes_since").
 *
 * Witness: two records at versions 1..2, a bulk reset, one new record at
 * version 1. Before the fix the old version-2 token read as "nothing new" and
 * returned a version-1 watermark, so the consumer kept the deleted rows and
 * never saw the new record.
 *
 * Pruned history is the second way a token goes stale. With
 * PDPP_CHANGE_HISTORY_LIMIT set, pruning keeps each live key's current anchor
 * and its newest row at or below the retention horizon (version - limit), so
 * every cursor at or above the horizon can resolve a predecessor snapshot and a
 * later delete keeps its tombstone. The horizon is stored as the stream's
 * `changes_floor`; a token below it returns 410 `cursor_expired`, because
 * MIN(version) cannot say so (a cold anchor pins it near 1).
 *
 * Both backends run the same scenarios. The page-cursor scenario is SQLite
 * only: the PostgreSQL changes feed returns one unpaged response.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";
import { fileURLToPath } from "node:url";
import { connectorInstanceAdvisoryLockKey } from "../server/connector-instance-write-coordinator.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { SqliteDriver } from "../server/sqlite-driver.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import * as postgresRecordsModule from "../server/postgres-records.ts";
import { deleteAllRecords, ingestRecord, queryRecords } from "../server/records.ts";
import { applyCompaction, type CompactionPolicy, planCompaction } from "../scripts/compact-record-history.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-07-17T00:00:00.000Z";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const MANIFEST = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "seed-manifests", "spotify.json"), "utf8"));
const CONNECTOR_KEY_RAW = canonicalConnectorKey(MANIFEST.connector_id);
assert.ok(CONNECTOR_KEY_RAW, "fixture: spotify.json must declare a canonicalizable connector_id");
const CONNECTOR_KEY: string = CONNECTOR_KEY_RAW;
const STREAM = MANIFEST.streams[0].name;
const OTHER_STREAM = MANIFEST.streams[1].name;

interface ListPage {
  data: Array<{ deleted?: boolean; id: string }>;
  has_more: boolean;
  next_changes_since?: string;
  next_cursor?: string;
}

interface Backend {
  /** A token in the format this backend issued before the epoch existed. */
  legacyToken(version: number): string;
  list(params: Record<string, unknown>, fields?: string[]): Promise<ListPage>;
  paged: boolean;
  put(key: string, popularity?: number, name?: string): Promise<void>;
  remove(key: string): Promise<void>;
  reset(stream?: string): Promise<void>;
  teardown(): Promise<void>;
}

function storageTarget(instanceId: string) {
  return { connector_id: CONNECTOR_KEY, connector_instance_id: instanceId };
}

function makeBackend(instanceId: string, kind: "sqlite" | "postgres", teardown: () => Promise<void>): Backend {
  const target = storageTarget(instanceId);
  return {
    legacyToken: (version) =>
      kind === "sqlite"
        ? Buffer.from(JSON.stringify({ kind: "changes_since", version })).toString("base64")
        : Buffer.from(JSON.stringify({ v: version })).toString("base64url"),
    list: async (params, fields) => {
      const grant = { streams: [fields ? { fields, name: STREAM } : { name: STREAM }] };
      const page = await queryRecords(target, STREAM, grant, params, MANIFEST);
      return page as unknown as ListPage;
    },
    paged: kind === "sqlite",
    put: (key, popularity, name) =>
      ingestRecord(target, {
        data: {
          id: key,
          ...(popularity === undefined ? {} : { popularity }),
          ...(name === undefined ? {} : { name }),
        },
        emitted_at: NOW,
        key,
        stream: STREAM,
      }) as unknown as Promise<void>,
    remove: (key) =>
      ingestRecord(target, {
        data: { id: key },
        emitted_at: NOW,
        key,
        op: "delete",
        stream: STREAM,
      }) as unknown as Promise<void>,
    reset: async (stream = STREAM) => {
      await deleteAllRecords(target, stream);
    },
    teardown,
  };
}

async function sqliteBackend(instanceId: string): Promise<Backend> {
  initDb();
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_KEY, JSON.stringify(MANIFEST), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, 'Spotify source', 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(instanceId, OWNER_SUBJECT_ID, CONNECTOR_KEY, instanceId, NOW, NOW);
  return makeBackend(instanceId, "sqlite", async () => closeDb());
}

async function postgresBackend(instanceId: string): Promise<Backend> {
  assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL is required for this test");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [instanceId]);
  await postgresQuery(
    `INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)
       ON CONFLICT (connector_id) DO NOTHING`,
    [CONNECTOR_KEY, JSON.stringify(MANIFEST), NOW]
  );
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES($1, $2, $3, 'Spotify source', 'active', 'account', $1, '{}'::jsonb, $4, $4, NULL)`,
    [instanceId, OWNER_SUBJECT_ID, CONNECTOR_KEY, NOW]
  );
  return makeBackend(instanceId, "postgres", async () => {
    await deleteAllRecords(storageTarget(instanceId), STREAM);
    await deleteAllRecords(storageTarget(instanceId), OTHER_STREAM);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [instanceId]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_KEY]);
    await closePostgresStorage();
  });
}

function ids(page: ListPage): string[] {
  return page.data.map((record) => record.id).sort();
}

function defineScenarios(label: string, open: (instanceId: string) => Promise<Backend>, skip: string | false) {
  const scenario = (
    name: string,
    run: (backend: Backend) => Promise<void>,
    options: { historyLimit?: number; needsPaging?: boolean } = {}
  ) => {
    const instanceId = `cin_cs_epoch_${label}_${name.replace(/\W+/g, "_").slice(0, 40)}`;
    test(`${label}: ${name}`, {
      skip: skip || (options.needsPaging && label !== "sqlite" ? "PostgreSQL changes feed is unpaged" : false),
    }, async () => {
      const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
      if (options.historyLimit !== undefined) {
        process.env.PDPP_CHANGE_HISTORY_LIMIT = String(options.historyLimit);
      }
      const backend = await open(instanceId);
      try {
        await run(backend);
      } finally {
        await backend.teardown();
        if (priorLimit === undefined) {
          delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
        } else {
          process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
        }
      }
    });
  };

  async function syncTwoThenResetAndReingestOne(backend: Backend) {
    await backend.put("old1");
    await backend.put("old2");
    const bootstrap = await backend.list({ changes_since: "beginning" });
    assert.deepEqual(ids(bootstrap), ["old1", "old2"]);
    assert.ok(bootstrap.next_changes_since);
    await backend.reset();
    await backend.put("new1");
    return bootstrap.next_changes_since;
  }

  scenario("a token minted before a bulk reset is rejected with cursor_expired", async (backend) => {
    const oldToken = await syncTwoThenResetAndReingestOne(backend);
    await assert.rejects(backend.list({ changes_since: oldToken }), { code: "cursor_expired" });
  });

  scenario("beginning after a reset returns the new records and a usable token", async (backend) => {
    await syncTwoThenResetAndReingestOne(backend);
    const full = await backend.list({ changes_since: "beginning" });
    assert.deepEqual(ids(full), ["new1"]);
    assert.ok(full.next_changes_since);
    await backend.put("new2");
    const delta = await backend.list({ changes_since: full.next_changes_since });
    assert.deepEqual(ids(delta), ["new2"], "a token issued after the reset is accepted and delivers only newer writes");
  });

  scenario("a token without an epoch still works when no reset has happened", async (backend) => {
    await backend.put("a");
    await backend.put("b");
    await backend.put("c");
    const delta = await backend.list({ changes_since: backend.legacyToken(2) });
    assert.deepEqual(ids(delta), ["c"]);
    assert.ok(delta.next_changes_since, "the response upgrades the caller to an epoch-bound token");
  });

  scenario("a token without an epoch is rejected once a reset has happened", async (backend) => {
    await backend.put("a");
    await backend.put("b");
    await backend.reset();
    await backend.put("c");
    await backend.put("d");
    await assert.rejects(backend.list({ changes_since: backend.legacyToken(2) }), { code: "cursor_expired" });
  });

  scenario("a reset that touches no data does not expire tokens", async (backend) => {
    await backend.put("a");
    const bootstrap = await backend.list({ changes_since: "beginning" });
    await backend.reset(OTHER_STREAM);
    await backend.put("b");
    const delta = await backend.list({ changes_since: bootstrap.next_changes_since });
    assert.deepEqual(ids(delta), ["b"]);
  });

  scenario(
    "a changes page cursor that spans a reset is rejected",
    async (backend) => {
      await backend.put("a");
      await backend.put("b");
      await backend.put("c");
      const first = await backend.list({ changes_since: "beginning", limit: 1 });
      assert.equal(first.has_more, true);
      assert.ok(first.next_cursor);
      const sameSession = await backend.list({ cursor: first.next_cursor, limit: 1 });
      assert.equal(sameSession.data.length, 1, "the cursor works before the reset");
      await backend.reset();
      await backend.put("d");
      await backend.put("e");
      await backend.put("f");
      await assert.rejects(backend.list({ cursor: first.next_cursor, limit: 1 }), { code: "cursor_expired" });
    },
    { needsPaging: true }
  );

  // Versions: cold=1, victim=2, hot=3..5 (hot's older rows are pruned), victim
  // deleted=6. Victim's version-2 row is then pruned, so a watermark-2 cursor
  // cannot tell the tombstone is a deletion of a record the consumer holds.
  scenario(
    "a token whose predecessor snapshots were pruned is rejected instead of dropping a tombstone",
    async (backend) => {
      await backend.put("cold");
      await backend.put("victim");
      const synced = await backend.list({ changes_since: "beginning" });
      assert.deepEqual(ids(synced), ["cold", "victim"]);
      assert.ok(synced.next_changes_since);
      await backend.put("hot", 1);
      await backend.put("hot", 2);
      await backend.put("hot", 3);
      await backend.remove("victim");
      await assert.rejects(backend.list({ changes_since: synced.next_changes_since }), { code: "cursor_expired" });
      const fresh = await backend.list({ changes_since: "beginning" });
      assert.deepEqual(ids(fresh), ["cold", "hot"], "a full re-sync sees the post-delete state");
    },
    { historyLimit: 2 }
  );

  // Versions: cold=1, hot=2..4 (pruning advances the floor to 4), victim=5,
  // token at 5, victim deleted=6. The token is newer than every pruned row.
  scenario(
    "a token newer than the pruned range still receives the tombstone",
    async (backend) => {
      await backend.put("cold");
      await backend.put("hot", 1);
      await backend.put("hot", 2);
      await backend.put("hot", 3);
      await backend.put("victim");
      const synced = await backend.list({ changes_since: "beginning" });
      assert.deepEqual(ids(synced), ["cold", "hot", "victim"]);
      assert.ok(synced.next_changes_since);
      await backend.remove("victim");
      const delta = await backend.list({ changes_since: synced.next_changes_since });
      assert.deepEqual(
        delta.data.map((record) => [record.id, record.deleted === true]),
        [["victim", true]]
      );
    },
    { historyLimit: 2 }
  );

  // Versions: cold=1, victim=2, hot=3..5, sync at 5, victim deleted=6. The
  // delete would prune victim's version-2 snapshot, its predecessor at
  // watermark 5, if pruning kept only current anchors. Each key's newest row at
  // or below the horizon is kept, so the tombstone must be emitted.
  scenario(
    "a fresh token taken just before a delete receives the tombstone",
    async (backend) => {
      await backend.put("cold");
      await backend.put("victim");
      await backend.put("hot", 1);
      await backend.put("hot", 2);
      await backend.put("hot", 3);
      const synced = await backend.list({ changes_since: "beginning" });
      assert.deepEqual(ids(synced), ["cold", "hot", "victim"]);
      assert.ok(synced.next_changes_since);
      await backend.remove("victim");
      const delta = await backend.list({ changes_since: synced.next_changes_since });
      assert.deepEqual(
        delta.data.map((record) => [record.id, record.deleted === true]),
        [["victim", true]]
      );
    },
    { historyLimit: 2 }
  );

  // Versions: cold=1, hot=2..4, sync at 4, cold updated=5. Updating a cold key
  // prunes nothing a current token needs, so the token must not expire.
  scenario(
    "updating a cold key does not expire a current token",
    async (backend) => {
      await backend.put("cold");
      await backend.put("hot", 1);
      await backend.put("hot", 2);
      await backend.put("hot", 3);
      const synced = await backend.list({ changes_since: "beginning" });
      assert.ok(synced.next_changes_since);
      await backend.put("cold", 9);
      const delta = await backend.list({ changes_since: synced.next_changes_since });
      assert.deepEqual(ids(delta), ["cold"]);
    },
    { historyLimit: 2 }
  );

  // One key, limit 1: A@1, A@2, A@3 prunes A@1, so MIN(version) is 2 and the
  // old minimum check rejected `beginning` (0 < MIN - 1). The recovery request
  // after a 410 must itself always work.
  scenario(
    "beginning still works after pruning raised the minimum retained version",
    async (backend) => {
      await backend.put("a", 1);
      await backend.put("a", 2);
      await backend.put("a", 3);
      const full = await backend.list({ changes_since: "beginning" });
      assert.deepEqual(ids(full), ["a"]);
      assert.ok(full.next_changes_since);
      await backend.put("a", 4);
      const delta = await backend.list({ changes_since: full.next_changes_since });
      assert.deepEqual(ids(delta), ["a"]);
    },
    { historyLimit: 1 }
  );

  // Versions: a=1, b=2, c=3, session starts at 3 (one record per page), then b
  // changes at 4 and hot churns to 6. Pruning supersedes b's version-2 row, so
  // the session's snapshot at 3 is gone. A continued page must be snapshot
  // exact or 410; silently omitting b is not acceptable.
  scenario(
    "a beginning session whose snapshot is pruned between pages never omits a record silently",
    async (backend) => {
      await backend.put("a", 1);
      await backend.put("b", 1);
      await backend.put("c", 1);
      const first = await backend.list({ changes_since: "beginning", limit: 1 });
      assert.equal(first.has_more, true);
      assert.ok(first.next_cursor);
      await backend.put("b", 2);
      await backend.put("hot", 1);
      await backend.put("hot", 2);
      const seen = new Set(ids(first));
      let cursor: string | undefined = first.next_cursor;
      let expired = false;
      while (cursor) {
        try {
          const page = await backend.list({ cursor, limit: 1 });
          for (const id of ids(page)) {
            seen.add(id);
          }
          cursor = page.has_more ? page.next_cursor : undefined;
        } catch (error) {
          assert.equal((error as { code?: string }).code, "cursor_expired");
          expired = true;
          cursor = undefined;
        }
      }
      assert.ok(expired || ["a", "b", "c"].every((id) => seen.has(id)), `silent omission: saw ${[...seen].join()}`);
    },
    { historyLimit: 2, needsPaging: true }
  );

  // Versions: cold=1, hot=2..4 (limit 2, so the horizon H is 2). A token at H
  // keeps every predecessor it needs and must work; a token at H-1 does not.
  scenario(
    "a token exactly at the retention horizon works and one below it expires",
    async (backend) => {
      await backend.put("cold");
      await backend.put("hot", 1);
      await backend.put("hot", 2);
      await backend.put("hot", 3);
      const atHorizon = await backend.list({ changes_since: backend.legacyToken(2) });
      assert.deepEqual(ids(atHorizon), ["hot"]);
      await assert.rejects(backend.list({ changes_since: backend.legacyToken(1) }), { code: "cursor_expired" });
    },
    { historyLimit: 2 }
  );

  // Versions: cold=1, hot=2 (popularity 1), sync at 2, hot popularity 2 and 3
  // at 3 and 4. The grant hides popularity, so the cold baseline kept by
  // retention must not turn the hidden-only updates into visible changes.
  scenario(
    "a hidden-only change stays suppressed after retention keeps cold baselines",
    async (backend) => {
      await backend.put("cold");
      await backend.put("hot", 1);
      const synced = await backend.list({ changes_since: "beginning" }, ["id"]);
      assert.ok(synced.next_changes_since);
      await backend.put("hot", 2);
      await backend.put("hot", 3);
      const delta = await backend.list({ changes_since: synced.next_changes_since }, ["id"]);
      assert.deepEqual(ids(delta), []);
    },
    { historyLimit: 2 }
  );

  scenario(
    "a bulk reset clears the pruned-history floor",
    async (backend) => {
      for (const key of ["a", "b", "c", "d"]) {
        await backend.put(key, 1);
        await backend.put(key, 2);
      }
      await backend.reset();
      await backend.put("e");
      await backend.put("f");
      await backend.put("g");
      const synced = await backend.list({ changes_since: "beginning" });
      assert.ok(synced.next_changes_since);
      await backend.put("h");
      const delta = await backend.list({ changes_since: synced.next_changes_since });
      assert.deepEqual(ids(delta), ["h"]);
    },
    { historyLimit: 2 }
  );
}

defineScenarios("sqlite", sqliteBackend, false);
defineScenarios("postgres", postgresBackend, POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set");

// A database created before `changes_floor` existed may already have pruned
// history without keeping each key's baseline. With retention on, the upgrade
// seeds the floor at the head so existing cursors expire once; with retention
// off nothing was pruned and the floor starts at 0.
for (const { limit, expectSeeded } of [
  { expectSeeded: true, limit: "3" },
  { expectSeeded: false, limit: undefined },
]) {
  test(`sqlite: adding changes_floor ${expectSeeded ? "seeds it at the head" : "leaves it at 0"} when retention is ${expectSeeded ? "on" : "off"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-floor-upgrade-"));
    const path = join(dir, "ri.sqlite");
    const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
    try {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
      initDb(path);
      getDb()
        .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
        .run(CONNECTOR_KEY, JSON.stringify(MANIFEST), NOW);
      await ingestRecord(CONNECTOR_KEY, { data: { id: "a" }, emitted_at: NOW, key: "a", stream: STREAM });
      await ingestRecord(CONNECTOR_KEY, { data: { id: "b" }, emitted_at: NOW, key: "b", stream: STREAM });
      await ingestRecord(CONNECTOR_KEY, { data: { id: "c" }, emitted_at: NOW, key: "c", stream: STREAM });
      getDb().exec("ALTER TABLE version_counter DROP COLUMN changes_floor");
      closeDb();

      if (limit !== undefined) {
        process.env.PDPP_CHANGE_HISTORY_LIMIT = limit;
      }
      initDb(path);
      const row = getDb().prepare("SELECT max_version, changes_floor FROM version_counter").get() as {
        changes_floor: number;
        max_version: number;
      };
      assert.equal(row.max_version, 3);
      assert.equal(row.changes_floor, expectSeeded ? row.max_version : 0);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
      if (priorLimit === undefined) {
        delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
      } else {
        process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
      }
    }
  });
}

test("postgres: adding changes_floor seeds it at the head when retention is on", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const instanceId = "cin_cs_epoch_postgres_floor_upgrade";
  const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
  const backend = await postgresBackend(instanceId);
  try {
    await backend.put("a");
    await backend.put("b");
    await backend.put("c");
    // The test-database guard refuses to re-admit a database holding records,
    // so empty the record tables and keep the version counter under test.
    await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1", [instanceId]);
    await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [instanceId]);
    await postgresQuery("ALTER TABLE version_counter DROP COLUMN changes_floor");
    await closePostgresStorage();

    process.env.PDPP_CHANGE_HISTORY_LIMIT = "3";
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
    const { rows } = await postgresQuery(
      "SELECT max_version::int AS max_version, changes_floor::int AS changes_floor FROM version_counter WHERE connector_instance_id = $1",
      [instanceId]
    );
    assert.deepEqual(rows, [{ changes_floor: 3, max_version: 3 }]);
  } finally {
    if (priorLimit === undefined) {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    } else {
      process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
    }
    await backend.teardown();
  }
});

// A pre-instance-namespace SQLite database rebuilds version_counter from scratch
// (copying only max_version). The rebuilt counter must still get a floor, seeded
// when retention is on, like any other upgrade.
test("sqlite: a legacy counter-table rebuild still seeds changes_floor at the head when retention is on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-floor-legacy-"));
  const path = join(dir, "ri.sqlite");
  const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
  try {
    delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    initDb(path);
    getDb().exec(`
      DROP TABLE version_counter;
      CREATE TABLE version_counter (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        max_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(connector_id, stream)
      );
      INSERT INTO version_counter(connector_id, stream, max_version) VALUES ('spotify', 'top_artists', 7);
    `);
    closeDb();

    process.env.PDPP_CHANGE_HISTORY_LIMIT = "3";
    initDb(path);
    const row = getDb().prepare("SELECT max_version, changes_floor FROM version_counter").get() as {
      changes_floor: number;
      max_version: number;
    };
    assert.deepEqual({ ...row }, { changes_floor: 7, max_version: 7 });
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
    if (priorLimit === undefined) {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    } else {
      process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
    }
  }
});

// Versions: cold=1, victim=2, victim deleted=3 (head 3, floor 1). A reader
// holding token 2 passes the floor check, then two concurrent ingests (hot=4,
// 5) move the horizon to 3 and prune victim's version-2 baseline. Reading on
// separate pool queries, the reader then dropped the tombstone and returned
// token 3, which equals the new floor and stays valid forever. One snapshot
// read sees the state its floor check saw and emits the tombstone.
test("postgres: a prune landing mid-read cannot make the changes feed drop a tombstone", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
  process.env.PDPP_CHANGE_HISTORY_LIMIT = "2";
  const backend = await postgresBackend("cin_cs_epoch_postgres_read_race");
  try {
    await backend.put("cold");
    await backend.put("victim");
    const synced = await backend.list({ changes_since: "beginning" });
    assert.ok(synced.next_changes_since);
    await backend.remove("victim");
    let fired = 0;
    postgresRecordsModule.__setPostgresChangesSinceReadHookForTest(async (point: string) => {
      if (point === "after-floor-read" && fired === 0) {
        fired += 1;
        await backend.put("hot", 1);
        await backend.put("hot", 2);
      }
    });
    const delta = await backend.list({ changes_since: synced.next_changes_since });
    assert.equal(fired, 1, "the hook must have interleaved the prune");
    assert.deepEqual(
      delta.data.map((record) => [record.id, record.deleted === true]),
      [["victim", true]]
    );
    // The writes really did move the horizon past the reader's token.
    const { rows } = await postgresQuery("SELECT changes_floor::int AS changes_floor FROM version_counter");
    assert.ok(rows.some((row) => row.changes_floor > 2));
  } finally {
    postgresRecordsModule.__setPostgresChangesSinceReadHookForTest(null);
    if (priorLimit === undefined) {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    } else {
      process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
    }
    await backend.teardown();
  }
});

// Compaction deletes history rows outside the ingest prune. Retention is off
// here so only compaction can account for them. The policy ignores
// `popularity`, so A@2 (0), A@3 (1) and A@4 (0) share a fingerprint and audit
// mode removes A@3. A client holding token 3 would then resolve A@2 as its
// baseline (popularity 0), see an unchanged A@4 and never learn popularity was
// 1 in between.
test("postgres: compaction expires tokens whose baseline it removed", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const instanceId = "cin_cs_epoch_postgres_compaction";
  const backend = await postgresBackend(instanceId);
  const pool = new pg.Pool({ connectionString: POSTGRES_URL });
  const runId = `cs_epoch_${Date.now()}`;
  try {
    await backend.put("cold");
    await backend.put("a", 0);
    await backend.put("a", 1);
    const synced = await backend.list({ changes_since: "beginning" });
    assert.ok(synced.next_changes_since);
    await backend.put("a", 0);

    const policy: CompactionPolicy = {
      connectorIds: [CONNECTOR_KEY],
      connectorSource: "test",
      excludeKeys: ["popularity"],
      stream: STREAM,
    };
    const plan = await planCompaction({
      connectorInstanceId: instanceId,
      limitKeys: null,
      policy,
      pool,
      stream: STREAM,
    });
    assert.equal(plan.removableVersions, 1, "audit mode removes the middle version");
    await applyCompaction({ plan, pool, runId });

    await assert.rejects(backend.list({ changes_since: synced.next_changes_since }), { code: "cursor_expired" });
    const fresh = await backend.list({ changes_since: "beginning" });
    assert.deepEqual(ids(fresh), ["a", "cold"]);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "compact_record_history_backup_${runId}"`);
    await pool.end();
    await backend.teardown();
  }
});

const POPULARITY_BLIND_POLICY: CompactionPolicy = {
  connectorIds: [CONNECTOR_KEY],
  connectorSource: "test",
  excludeKeys: ["popularity"],
  stream: STREAM,
};

// A@1 (0), A@2 (1), A@3 (0) share a fingerprint under a policy that ignores
// popularity. The planner reads the current row (A@2), then a write lands
// (A@3), then the planner reads the history. It marks @3 removable although @3
// is now the current anchor. Applying it would erase the current projection's
// history row and, with no successor, raise no floor. The wrapper below puts the
// write exactly between the planner's two reads.
test("postgres: compaction refuses a stale plan that would delete the current anchor", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const instanceId = "cin_cs_epoch_postgres_compaction_stale";
  const backend = await postgresBackend(instanceId);
  const pool = new pg.Pool({ connectionString: POSTGRES_URL });
  const runId = `cs_epoch_stale_${Date.now()}`;
  try {
    await backend.put("a", 0);
    await backend.put("a", 1);
    let fired = false;
    const racingPool = {
      query: async (text: string, values?: unknown[]) => {
        if (!fired && /FROM record_changes/.test(text) && /record_key = \$3/.test(text)) {
          fired = true;
          await backend.put("a", 0);
        }
        return pool.query(text, values);
      },
    } as unknown as pg.Pool;
    const plan = await planCompaction({
      connectorInstanceId: instanceId,
      limitKeys: null,
      policy: POPULARITY_BLIND_POLICY,
      pool: racingPool,
      stream: STREAM,
    });
    assert.equal(fired, true, "the write must land between the planner's reads");
    assert.deepEqual(plan.removableByKey.get("a"), [3], "the racing plan names the current anchor");
    await assert.rejects(applyCompaction({ plan, pool, runId }), /is the current anchor or has no successor/);
    const { rows } = await pool.query(
      "SELECT version::int AS version FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version",
      [instanceId, STREAM]
    );
    assert.deepEqual(
      rows.map((row) => row.version),
      [1, 2, 3]
    );
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "compact_record_history_backup_${runId}"`);
    await pool.end();
    await backend.teardown();
  }
});

// Ingest takes the stream's version_counter row lock before it touches history.
// Compaction must take the same lock first, or the two can deadlock. While
// another transaction holds the counter, a queued compaction must not have
// touched its candidate row yet: the holder can still delete that row at once.
test("postgres: compaction takes the stream counter lock before it deletes history", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const instanceId = "cin_cs_epoch_postgres_compaction_lock_order";
  const backend = await postgresBackend(instanceId);
  const pool = new pg.Pool({ connectionString: POSTGRES_URL });
  const runId = `cs_epoch_lock_${Date.now()}`;
  const holder = await pool.connect();
  // Compaction waits behind the holder for at most the instance-lock budget, and
  // the polling below can take longer than its 2 s default on a busy host.
  const priorWait = process.env.PDPP_INGEST_LOCK_WAIT_MS;
  process.env.PDPP_INGEST_LOCK_WAIT_MS = "30000";
  try {
    await backend.put("a", 0);
    await backend.put("a", 1);
    await backend.put("a", 0);
    await backend.put("a", 1);
    const plan = await planCompaction({
      connectorInstanceId: instanceId,
      limitKeys: null,
      policy: POPULARITY_BLIND_POLICY,
      pool,
      stream: STREAM,
    });
    assert.ok(plan.removableVersions >= 1, "the fixture must yield a removable version");
    const candidate = plan.removableByKey.get("a")?.[0];
    assert.ok(candidate !== undefined);

    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM version_counter WHERE connector_instance_id = $1 AND stream = $2 FOR UPDATE", [
      instanceId,
      STREAM,
    ]);
    const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const applying = applyCompaction({ plan, pool, runId });
    applying.catch(() => undefined);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: polling for a lock wait is inherently sequential.
      const { rows } = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> $1 AND datname = current_database()",
        [holderPid]
      );
      waiting = rows.length > 0;
      if (!waiting) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(waiting, "compaction must be queued behind the counter lock");
    await holder.query("SET LOCAL lock_timeout = '500ms'");
    await holder.query(
      "DELETE FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 AND record_key = 'a' AND version = $3",
      [instanceId, STREAM, candidate]
    );
    await holder.query("ROLLBACK");
    await applying;
  } finally {
    if (priorWait === undefined) {
      delete process.env.PDPP_INGEST_LOCK_WAIT_MS;
    } else {
      process.env.PDPP_INGEST_LOCK_WAIT_MS = priorWait;
    }
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
    await pool.query(`DROP TABLE IF EXISTS "compact_record_history_backup_${runId}"`);
    await pool.end();
    await backend.teardown();
  }
});

// The floor column and its one-time seed must commit together. If the seed
// fails after the column exists, the next startup has to seed again instead of
// seeing the column and skipping the seed forever.
test("sqlite: a failed changes_floor seed leaves the next startup able to seed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-floor-atomic-"));
  const path = join(dir, "ri.sqlite");
  const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
  try {
    delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    initDb(path);
    getDb()
      .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
      .run(CONNECTOR_KEY, JSON.stringify(MANIFEST), NOW);
    await ingestRecord(CONNECTOR_KEY, { data: { id: "a" }, emitted_at: NOW, key: "a", stream: STREAM });
    await ingestRecord(CONNECTOR_KEY, { data: { id: "b" }, emitted_at: NOW, key: "b", stream: STREAM });
    getDb().exec("ALTER TABLE version_counter DROP COLUMN changes_floor");
    // Only the seed changes max_version into changes_floor, so only it trips.
    getDb().exec(`CREATE TRIGGER fail_floor_seed BEFORE UPDATE ON version_counter
                  WHEN NEW.max_version IS OLD.max_version
                  BEGIN SELECT RAISE(ABORT, 'seed failed'); END`);
    closeDb();

    process.env.PDPP_CHANGE_HISTORY_LIMIT = "3";
    assert.throws(() => initDb(path), /seed failed/);
    closeDb();

    const raw = new SqliteDriver(path, { timeout: 30_000 }) as unknown as ReturnType<typeof getDb>;
    raw.exec("DROP TRIGGER fail_floor_seed");
    raw.close();
    initDb(path);
    const row = getDb().prepare("SELECT max_version, changes_floor FROM version_counter").get() as {
      changes_floor: number;
      max_version: number;
    };
    assert.deepEqual({ ...row }, { changes_floor: 2, max_version: 2 });
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
    if (priorLimit === undefined) {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    } else {
      process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
    }
  }
});

test("postgres: a failed changes_floor seed leaves the next startup able to seed", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const instanceId = "cin_cs_epoch_postgres_floor_atomic";
  const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
  const backend = await postgresBackend(instanceId);
  try {
    await backend.put("a");
    await backend.put("b");
    await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1", [instanceId]);
    await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [instanceId]);
    await postgresQuery("ALTER TABLE version_counter DROP COLUMN changes_floor");
    // Only the seed moves the floor; the trigger tolerates the column being absent.
    await postgresQuery(`CREATE OR REPLACE FUNCTION fail_floor_seed() RETURNS trigger AS $$
      BEGIN
        BEGIN
          IF NEW.changes_floor <> OLD.changes_floor THEN RAISE EXCEPTION 'seed failed'; END IF;
        EXCEPTION WHEN undefined_column THEN NULL;
        END;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await postgresQuery(
      "CREATE TRIGGER fail_floor_seed BEFORE UPDATE ON version_counter FOR EACH ROW EXECUTE FUNCTION fail_floor_seed()"
    );
    await closePostgresStorage();

    process.env.PDPP_CHANGE_HISTORY_LIMIT = "3";
    await assert.rejects(
      initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string }),
      /seed failed/
    );
    await closePostgresStorage();

    const admin = new pg.Pool({ connectionString: POSTGRES_URL });
    try {
      await admin.query("DROP TRIGGER fail_floor_seed ON version_counter");
    } finally {
      await admin.end();
    }
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
    const { rows } = await postgresQuery(
      "SELECT max_version::int AS max_version, changes_floor::int AS changes_floor FROM version_counter WHERE connector_instance_id = $1",
      [instanceId]
    );
    assert.deepEqual(rows, [{ changes_floor: 2, max_version: 2 }]);
  } finally {
    await postgresQuery("DROP TRIGGER IF EXISTS fail_floor_seed ON version_counter").catch(() => undefined);
    if (priorLimit === undefined) {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    } else {
      process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
    }
    await backend.teardown();
  }
});

// Retention is off at upgrade, but the history already has a hole: an earlier
// run pruned or compacted a row. Version 2 is missing below, so the stream
// cannot be shown to be complete and its floor starts at the head. A stream
// with every version present keeps floor 0 (see the retention-off test above).
test("sqlite: a history gap seeds changes_floor even when retention is off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-floor-gap-"));
  const path = join(dir, "ri.sqlite");
  const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
  try {
    delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    initDb(path);
    getDb()
      .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
      .run(CONNECTOR_KEY, JSON.stringify(MANIFEST), NOW);
    for (const key of ["a", "b", "c"]) {
      await ingestRecord(CONNECTOR_KEY, { data: { id: key }, emitted_at: NOW, key, stream: STREAM });
    }
    getDb().exec("DELETE FROM record_changes WHERE version = 2");
    getDb().exec("ALTER TABLE version_counter DROP COLUMN changes_floor");
    closeDb();

    initDb(path);
    const row = getDb().prepare("SELECT max_version, changes_floor FROM version_counter").get() as {
      changes_floor: number;
      max_version: number;
    };
    assert.deepEqual({ ...row }, { changes_floor: 3, max_version: 3 });
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
    if (priorLimit === undefined) {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    } else {
      process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
    }
  }
});

test("postgres: a history gap seeds changes_floor even when retention is off", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const instanceId = "cin_cs_epoch_postgres_floor_gap";
  const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
  delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
  const backend = await postgresBackend(instanceId);
  try {
    for (const key of ["a", "b", "c"]) {
      await backend.put(key);
    }
    await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 AND version = 2", [
      instanceId,
      STREAM,
    ]);
    // The test-database guard refuses to re-admit a database holding records;
    // the history rows (with the gap) and the counter stay under test.
    await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [instanceId]);
    await postgresQuery("ALTER TABLE version_counter DROP COLUMN changes_floor");
    await closePostgresStorage();
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
    const { rows } = await postgresQuery(
      "SELECT max_version::int AS max_version, changes_floor::int AS changes_floor FROM version_counter WHERE connector_instance_id = $1",
      [instanceId]
    );
    assert.deepEqual(rows, [{ changes_floor: 3, max_version: 3 }]);
  } finally {
    if (priorLimit === undefined) {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    } else {
      process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
    }
    await backend.teardown();
  }
});

// ─── Compaction versus stream resets ────────────────────────────────────────

/** Poll until `probe` returns something truthy. Lock waits are observed, not slept through. */
async function eventually<T>(what: string, probe: () => Promise<T | false | null | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await probe();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return assert.fail(`timed out waiting for ${what}`);
}

interface CompactionFixture {
  backend: Backend;
  instanceId: string;
  pool: pg.Pool;
  runId: string;
}

async function withCompactionFixture(name: string, run: (fixture: CompactionFixture) => Promise<void>): Promise<void> {
  const instanceId = `cin_cs_epoch_postgres_${name}`;
  const backend = await postgresBackend(instanceId);
  const pool = new pg.Pool({ connectionString: POSTGRES_URL });
  const runId = `cs_epoch_${name}_${Date.now()}`;
  try {
    await run({ backend, instanceId, pool, runId });
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "compact_record_history_backup_${runId}"`);
    await pool.end();
    await backend.teardown();
  }
}

function planPopularityBlind({ instanceId, pool }: Pick<CompactionFixture, "instanceId" | "pool">) {
  return planCompaction({
    connectorInstanceId: instanceId,
    limitKeys: null,
    policy: POPULARITY_BLIND_POLICY,
    pool,
    stream: STREAM,
  });
}

/** Popularity 0,1,0,1,0 is five versions that a popularity-blind policy treats as one: v2..v4 are redundant. */
async function putFlappingKey(backend: Backend): Promise<void> {
  for (const popularity of [0, 1, 0, 1, 0]) {
    await backend.put("a", popularity);
  }
}

async function storedHistory(pool: pg.Pool, instanceId: string) {
  const { rows } = await pool.query<{ name: string | null; popularity: string | null; version: number }>(
    `SELECT version::int AS version, record_json->>'name' AS name, record_json->>'popularity' AS popularity
       FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version`,
    [instanceId, STREAM]
  );
  return rows;
}

async function storedFloor(pool: pg.Pool, instanceId: string): Promise<number | null> {
  const { rows } = await pool.query<{ changes_floor: number }>(
    "SELECT changes_floor::int AS changes_floor FROM version_counter WHERE connector_instance_id = $1 AND stream = $2",
    [instanceId, STREAM]
  );
  return rows[0]?.changes_floor ?? null;
}

async function backupTableExists(pool: pg.Pool, runId: string): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [
    `compact_record_history_backup_${runId}`,
  ]);
  return rows[0]?.present === true;
}

// Generation 1 writes popularity 0,1,0,1,0 at versions 1..5, and a policy that
// ignores popularity marks versions 2..4 redundant. A bulk reset deletes the
// stream's history, rows and counter, so generation 2 reissues versions 1..6 for
// six different records. A plan that names versions 2..4 cannot tell its own
// rows from these: applying it deletes n2..n4 and raises the floor to 5.
test("postgres: compaction refuses a plan made before a stream reset reissued its version numbers", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  await withCompactionFixture("compaction_reset_aba", async ({ backend, instanceId, pool, runId }) => {
    await putFlappingKey(backend);
    const plan = await planPopularityBlind({ instanceId, pool });
    assert.deepEqual(plan.removableByKey.get("a"), [2, 3, 4]);

    await backend.reset();
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await backend.put("a", 0, `n${n}`);
    }

    await assert.rejects(applyCompaction({ plan, pool, runId }), /stale compaction plan/);
    assert.deepEqual(
      (await storedHistory(pool, instanceId)).map((row) => row.name),
      ["n1", "n2", "n3", "n4", "n5", "n6"],
      "no row of the new generation was deleted"
    );
    assert.equal(await storedFloor(pool, instanceId), 0, "the floor was not raised for rows that were not removed");
    assert.equal(await backupTableExists(pool, runId), false, "a refused apply leaves no backup table");
  });
});

// The reset generation alone must refuse. Here generation 2 rewrites the same
// five payloads, so every row digest still matches the plan; only the moved
// generation says the rows are not the ones the plan judged.
test("postgres: compaction refuses a plan from before a reset even when the rewritten history is identical", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  await withCompactionFixture("compaction_reset_identical", async ({ backend, instanceId, pool, runId }) => {
    await putFlappingKey(backend);
    const plan = await planPopularityBlind({ instanceId, pool });
    await backend.reset();
    await putFlappingKey(backend);

    await assert.rejects(applyCompaction({ plan, pool, runId }), /stale compaction plan.*reset generation/);
    assert.deepEqual(
      (await storedHistory(pool, instanceId)).map((row) => row.version),
      [1, 2, 3, 4, 5]
    );
  });
});

// The row digest alone must refuse. A connection wiped and re-enrolled under the
// same id loses its rows without a reset, so the generation stays put and the
// version numbers restart at 1.
test("postgres: compaction refuses a plan whose rows were replaced without a generation change", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  await withCompactionFixture("compaction_rows_replaced", async ({ backend, instanceId, pool, runId }) => {
    await putFlappingKey(backend);
    const plan = await planPopularityBlind({ instanceId, pool });
    for (const table of ["record_changes", "records", "version_counter"]) {
      await pool.query(`DELETE FROM ${table} WHERE connector_instance_id = $1`, [instanceId]);
    }
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await backend.put("a", 0, `n${n}`);
    }
    const generation = await pool.query(
      "SELECT record_reset_generation::text AS generation FROM connector_instances WHERE connector_instance_id = $1",
      [instanceId]
    );
    assert.equal(generation.rows[0]?.generation, "0", "fixture: nothing advanced the generation");

    await assert.rejects(applyCompaction({ plan, pool, runId }), /stale compaction plan.*changed since the plan/);
    assert.deepEqual(
      (await storedHistory(pool, instanceId)).map((row) => row.name),
      ["n1", "n2", "n3", "n4", "n5", "n6"]
    );
  });
});

// Every writer and every reset takes the connector instance's advisory lock
// first. Compaction has to queue behind a writer that holds it, and give up with
// a message an operator can act on when the wait is too long, without touching
// any row.
test("postgres: compaction waits on the connector-instance write lock and gives up with a clear error", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  await withCompactionFixture("compaction_instance_lock", async ({ backend, instanceId, pool, runId }) => {
    await putFlappingKey(backend);
    const plan = await planPopularityBlind({ instanceId, pool });
    const holder = await pool.connect();
    const priorWait = process.env.PDPP_INGEST_LOCK_WAIT_MS;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [connectorInstanceAdvisoryLockKey(instanceId)]);
      process.env.PDPP_INGEST_LOCK_WAIT_MS = "300";
      await assert.rejects(applyCompaction({ plan, pool, runId }), /is busy/);
    } finally {
      if (priorWait === undefined) {
        delete process.env.PDPP_INGEST_LOCK_WAIT_MS;
      } else {
        process.env.PDPP_INGEST_LOCK_WAIT_MS = priorWait;
      }
      await holder.query("ROLLBACK");
      holder.release();
    }
    assert.deepEqual(
      (await storedHistory(pool, instanceId)).map((row) => row.version),
      [1, 2, 3, 4, 5]
    );
    assert.equal(await storedFloor(pool, instanceId), 0);
    assert.equal(await backupTableExists(pool, runId), false, "a refused apply leaves no backup table");
  });
});

// A reset deletes record_changes first and version_counter last, and compaction
// holds the version_counter row while it deletes record_changes rows. Each
// waited on the other. Both now take the instance lock first, so a reset that
// starts while compaction is applying queues behind it instead of deadlocking.
// A test-held counter row parks compaction right after it took the instance
// lock, which makes the interleaving deterministic.
test("postgres: a reset that starts while compaction is applying queues on the instance lock instead of deadlocking", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const priorWait = process.env.PDPP_INGEST_LOCK_WAIT_MS;
  process.env.PDPP_INGEST_LOCK_WAIT_MS = "30000";
  try {
    await withCompactionFixture("compaction_reset_race", async ({ backend, instanceId, pool, runId }) => {
      await putFlappingKey(backend);
      const plan = await planPopularityBlind({ instanceId, pool });
      assert.deepEqual(plan.removableByKey.get("a"), [2, 3, 4]);
      const applyPool = new pg.Pool({ application_name: "cs_epoch_apply", connectionString: POSTGRES_URL });
      const holder = await pool.connect();
      let applying: Promise<{ deleted: number }> | undefined;
      let resetting: Promise<void> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT 1 FROM version_counter WHERE connector_instance_id = $1 AND stream = $2 FOR UPDATE",
          [instanceId, STREAM]
        );
        applying = applyCompaction({ plan, pool: applyPool, runId });
        applying.catch(() => undefined);
        await eventually("compaction to park on the counter row", async () => {
          const { rows } = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name = 'cs_epoch_apply' AND wait_event_type = 'Lock'"
          );
          return rows.length > 0;
        });
        resetting = backend.reset();
        resetting.catch(() => undefined);
        await eventually("the reset to queue on the connector-instance lock", async () => {
          const { rows } = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'"
          );
          return rows.length > 0;
        });
        await holder.query("ROLLBACK");

        const [compacted] = await Promise.all([applying, resetting]);
        assert.equal(compacted.deleted, 3, "compaction finished first, with the plan it was given");
        assert.deepEqual(await storedHistory(pool, instanceId), [], "the reset then cleared the stream");
        assert.equal(await storedFloor(pool, instanceId), null);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        await Promise.allSettled([applying, resetting]);
        await applyPool.end();
      }
    });
  } finally {
    if (priorWait === undefined) {
      delete process.env.PDPP_INGEST_LOCK_WAIT_MS;
    } else {
      process.env.PDPP_INGEST_LOCK_WAIT_MS = priorWait;
    }
  }
});

// The floor is recorded on the counter row. Without that row compaction would
// delete history and record no floor, so the stale tokens would stay valid.
test("postgres: compaction refuses to remove history when the stream has no version counter row", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  await withCompactionFixture("compaction_no_counter", async ({ backend, instanceId, pool, runId }) => {
    await putFlappingKey(backend);
    const plan = await planPopularityBlind({ instanceId, pool });
    await pool.query("DELETE FROM version_counter WHERE connector_instance_id = $1 AND stream = $2", [
      instanceId,
      STREAM,
    ]);
    await assert.rejects(applyCompaction({ plan, pool, runId }), /version_counter row is missing/);
    assert.deepEqual(
      (await storedHistory(pool, instanceId)).map((row) => row.version),
      [1, 2, 3, 4, 5]
    );
    assert.equal(await backupTableExists(pool, runId), false, "a refused apply leaves no backup table");
  });
});

// ─── Counters lost before the floor existed ─────────────────────────────────

// A stream can hold history but no counter row (a lost counter). The seed only
// updated existing rows, so the first write after the upgrade made the allocator
// create the row with floor 0 and let stale tokens through. The seed now creates
// the row the allocator would, then seeds every row by the same rule.
const LOST_COUNTER_CASES = [
  { expectedFloor: 0, gap: false, limit: undefined, name: "complete history, retention off" },
  { expectedFloor: 3, gap: true, limit: undefined, name: "gapped history, retention off" },
  { expectedFloor: 3, gap: false, limit: "5", name: "complete history, retention on" },
] as const;

for (const { expectedFloor, gap, limit, name } of LOST_COUNTER_CASES) {
  test(`sqlite: the changes_floor seed restores the counter row of a stream that lost it (${name})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-floor-lost-counter-"));
    const path = join(dir, "ri.sqlite");
    const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
    try {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
      initDb(path);
      getDb()
        .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
        .run(CONNECTOR_KEY, JSON.stringify(MANIFEST), NOW);
      for (const key of ["a", "b", "c"]) {
        await ingestRecord(CONNECTOR_KEY, { data: { id: key }, emitted_at: NOW, key, stream: STREAM });
      }
      getDb().exec("DELETE FROM version_counter");
      if (gap) {
        getDb().exec("DELETE FROM record_changes WHERE version = 2");
      }
      getDb().exec("ALTER TABLE version_counter DROP COLUMN changes_floor");
      closeDb();

      if (limit !== undefined) {
        process.env.PDPP_CHANGE_HISTORY_LIMIT = limit;
      }
      initDb(path);
      const rows = getDb()
        .prepare("SELECT connector_id, stream, max_version, changes_floor FROM version_counter")
        .all();
      assert.deepEqual(
        rows.map((row: object) => ({ ...row })),
        [{ changes_floor: expectedFloor, connector_id: CONNECTOR_KEY, max_version: 3, stream: STREAM }]
      );

      // The allocator carries on from the restored row and keeps its floor.
      await ingestRecord(CONNECTOR_KEY, { data: { id: "d" }, emitted_at: NOW, key: "d", stream: STREAM });
      const after = getDb().prepare("SELECT max_version, changes_floor FROM version_counter").get();
      assert.deepEqual({ ...after }, { changes_floor: expectedFloor, max_version: 4 });
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
      if (priorLimit === undefined) {
        delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
      } else {
        process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
      }
    }
  });
}

// Current rows with no history and no counter: nothing proves the stream is
// complete, so its floor starts at the head even with retention off.
test("sqlite: the changes_floor seed restores a counter for current rows that have no history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-floor-no-history-"));
  const path = join(dir, "ri.sqlite");
  const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
  try {
    delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    initDb(path);
    getDb()
      .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
      .run(CONNECTOR_KEY, JSON.stringify(MANIFEST), NOW);
    for (const key of ["a", "b", "c"]) {
      await ingestRecord(CONNECTOR_KEY, { data: { id: key }, emitted_at: NOW, key, stream: STREAM });
    }
    getDb().exec("DELETE FROM version_counter");
    getDb().exec("DELETE FROM record_changes");
    getDb().exec("ALTER TABLE version_counter DROP COLUMN changes_floor");
    closeDb();

    initDb(path);
    const row = getDb().prepare("SELECT max_version, changes_floor FROM version_counter").get();
    assert.deepEqual({ ...row }, { changes_floor: 3, max_version: 3 });
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
    if (priorLimit === undefined) {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    } else {
      process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
    }
  }
});

for (const [index, { expectedFloor, gap, limit, name }] of LOST_COUNTER_CASES.entries()) {
  test(`postgres: the changes_floor seed restores the counter row of a stream that lost it (${name})`, {
    skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
  }, async () => {
    const instanceId = `cin_cs_epoch_postgres_floor_lost_counter_${index}`;
    const priorLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
    delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    const backend = await postgresBackend(instanceId);
    try {
      for (const key of ["a", "b", "c"]) {
        await backend.put(key);
      }
      await postgresQuery("DELETE FROM version_counter WHERE connector_instance_id = $1", [instanceId]);
      if (gap) {
        await postgresQuery(
          "DELETE FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 AND version = 2",
          [instanceId, STREAM]
        );
      }
      // The test-database guard refuses to re-admit a database holding records;
      // the history rows stay under test, which is the shape of a lost counter.
      await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [instanceId]);
      await postgresQuery("ALTER TABLE version_counter DROP COLUMN changes_floor");
      await closePostgresStorage();

      if (limit !== undefined) {
        process.env.PDPP_CHANGE_HISTORY_LIMIT = limit;
      }
      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
      const counter = await postgresQuery(
        `SELECT connector_id, stream, max_version::int AS max_version, changes_floor::int AS changes_floor
           FROM version_counter WHERE connector_instance_id = $1`,
        [instanceId]
      );
      assert.deepEqual(counter.rows, [
        { changes_floor: expectedFloor, connector_id: CONNECTOR_KEY, max_version: 3, stream: STREAM },
      ]);

      // The allocator carries on from the restored row and keeps its floor.
      await backend.put("d");
      const after = await postgresQuery(
        "SELECT max_version::int AS max_version, changes_floor::int AS changes_floor FROM version_counter WHERE connector_instance_id = $1",
        [instanceId]
      );
      assert.deepEqual(after.rows, [{ changes_floor: expectedFloor, max_version: 4 }]);
    } finally {
      if (priorLimit === undefined) {
        delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
      } else {
        process.env.PDPP_CHANGE_HISTORY_LIMIT = priorLimit;
      }
      await backend.teardown();
    }
  });
}

// ─── Seed lock ──────────────────────────────────────────────────────────────

// The seed takes an ACCESS EXCLUSIVE lock on version_counter. Queued behind a
// long-running transaction, that request makes every ingest and read of the
// table queue behind it. A bounded lock_timeout makes startup fail instead, with
// a message that names the cause, and the next start can seed.
test("postgres: the changes_floor seed gives up with a clear error while a long transaction holds version_counter", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  const instanceId = "cin_cs_epoch_postgres_floor_lock_timeout";
  const priorTimeout = process.env.PDPP_POSTGRES_CHANGES_FLOOR_LOCK_TIMEOUT_MS;
  const backend = await postgresBackend(instanceId);
  const holder = new pg.Client({ connectionString: POSTGRES_URL });
  let holderOpen = false;
  try {
    await backend.put("a");
    await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1", [instanceId]);
    await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [instanceId]);
    await postgresQuery("ALTER TABLE version_counter DROP COLUMN changes_floor");
    await closePostgresStorage();

    await holder.connect();
    holderOpen = true;
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM version_counter LIMIT 1");

    process.env.PDPP_POSTGRES_CHANGES_FLOOR_LOCK_TIMEOUT_MS = "300";
    let outcome: unknown;
    let settled = false;
    initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string }).then(
      () => {
        settled = true;
        outcome = "started";
      },
      (error: unknown) => {
        settled = true;
        outcome = error;
      }
    );
    await eventually("startup to give up on the version_counter lock", async () => settled);
    assert.ok(outcome instanceof Error, `startup must fail, got ${String(outcome)}`);
    assert.match(outcome.message, /changes_floor/);
    assert.match(outcome.message, /version_counter/);
    assert.match(outcome.message, /300ms/);

    await holder.query("ROLLBACK");
    holderOpen = false;
    await closePostgresStorage();
    delete process.env.PDPP_POSTGRES_CHANGES_FLOOR_LOCK_TIMEOUT_MS;
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
    const column = await postgresQuery(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'version_counter' AND column_name = 'changes_floor'"
    );
    assert.equal(column.rows.length, 1, "the next start seeds once the lock is free");
  } finally {
    if (holderOpen) {
      await holder.query("ROLLBACK").catch(() => undefined);
    }
    await holder.end().catch(() => undefined);
    if (priorTimeout === undefined) {
      delete process.env.PDPP_POSTGRES_CHANGES_FLOOR_LOCK_TIMEOUT_MS;
    } else {
      process.env.PDPP_POSTGRES_CHANGES_FLOOR_LOCK_TIMEOUT_MS = priorTimeout;
    }
    await backend.teardown();
  }
});
