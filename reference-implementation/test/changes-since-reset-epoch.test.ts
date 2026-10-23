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
  data: Array<{ id: string }>;
  has_more: boolean;
  next_changes_since?: string;
  next_cursor?: string;
}

interface Backend {
  /** A token in the format this backend issued before the epoch existed. */
  legacyToken(version: number): string;
  list(params: Record<string, unknown>): Promise<ListPage>;
  paged: boolean;
  put(key: string, stream?: string): Promise<void>;
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
    put: (key, stream = STREAM) =>
      ingestRecord(target, { data: { id: key }, emitted_at: NOW, key, stream }) as unknown as Promise<void>,
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
    options: { needsPaging?: boolean } = {}
  ) => {
    const instanceId = `cin_cs_epoch_${label}_${name.replace(/\W+/g, "_").slice(0, 40)}`;
    test(`${label}: ${name}`, {
      skip: skip || (options.needsPaging && label !== "sqlite" ? "PostgreSQL changes feed is unpaged" : false),
    }, async () => {
      const backend = await open(instanceId);
      try {
        await run(backend);
      } finally {
        await backend.teardown();
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
}

defineScenarios("sqlite", sqliteBackend, false);
defineScenarios("postgres", postgresBackend, POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set");
