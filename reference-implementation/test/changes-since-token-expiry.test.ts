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
 * PDPP_CHANGE_HISTORY_LIMIT set, pruning keeps one anchor row per live key, so
 * MIN(version) in record_changes stays at a cold key's first version while
 * other keys' predecessor snapshots are gone. A token below the stream's
 * `changes_floor` (the newest version that superseded a pruned row) can no
 * longer show that a since-deleted key was ever visible, and its tombstone
 * would be dropped silently. Such a token returns 410 `cursor_expired`.
 *
 * Both backends run the same scenarios. The page-cursor scenario is SQLite
 * only: the PostgreSQL changes feed returns one unpaged response.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { deleteAllRecords, ingestRecord, queryRecords } from "../server/records.ts";

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
  list(params: Record<string, unknown>): Promise<ListPage>;
  paged: boolean;
  put(key: string, popularity?: number): Promise<void>;
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
    list: async (params) => {
      const page = await queryRecords(target, STREAM, { streams: [{ name: STREAM }] }, params, MANIFEST);
      return page as unknown as ListPage;
    },
    paged: kind === "sqlite",
    put: (key, popularity) =>
      ingestRecord(target, {
        data: popularity === undefined ? { id: key } : { id: key, popularity },
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
