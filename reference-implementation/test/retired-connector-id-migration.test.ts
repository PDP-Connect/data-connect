// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import {
  describeConnectorIdRename,
  migrateRenamedConnectorIdsSqlite,
} from "../server/connector-id-rename-migration.ts";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

type Db = ReturnType<typeof getDb>;

const NOW = "2026-11-14T00:00:00.000Z";
const SUPERSEDED_LOG = /were deleted \(connector_installs: 1, connectors: 1\)/;

function seedConnector(db: Db, connectorId: string): void {
  db.prepare("INSERT INTO connectors (connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    connectorId,
    JSON.stringify({ connector_id: connectorId, display_name: connectorId, streams: [] }),
    NOW
  );
}

function seedInstance(db: Db, instanceId: string, connectorId: string, binding: string): void {
  db.prepare(
    `INSERT INTO connector_instances
       (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind, source_binding_key, created_at, updated_at)
     VALUES (?, 'owner_local', ?, ?, 'local_device', ?, ?, ?)`
  ).run(instanceId, connectorId, connectorId, binding, NOW, NOW);
}

function ids(db: Db, table: string): string[] {
  return db
    .prepare(`SELECT connector_id FROM ${table} ORDER BY connector_id`)
    .all()
    .map((row) => String((row as { connector_id: string }).connector_id));
}

function withDb(fn: (db: Db) => void): () => void {
  return () => {
    const db = initDb(":memory:");
    try {
      fn(db);
    } finally {
      closeDb();
    }
  };
}

test(
  "the four underscore-spelled connector ids are renamed to their manifest keys",
  withDb((db) => {
    const pairs = [
      ["apple_photos", "apple-photos"],
      ["claude_code", "claude-code"],
      ["google_messages", "google-messages"],
      ["google_takeout", "google-takeout"],
    ] as const;
    for (const [oldId] of pairs) {
      seedConnector(db, oldId);
    }
    seedConnector(db, "claude_code_extra");
    migrateRenamedConnectorIdsSqlite(db);
    assert.deepEqual(
      ids(db, "connectors"),
      [...pairs.map(([, newId]) => newId), "claude_code_extra"].sort(),
      "each old id becomes its manifest key; an id that merely starts with one is untouched"
    );
  })
);

test(
  "renames retired ids in every table, parent rows first, and a second run changes nothing",
  withDb((db) => {
    seedConnector(db, "claude_code");
    seedInstance(db, "inst_cc", "claude_code", "binding-a");
    db.prepare(
      "INSERT INTO connector_state (connector_id, connector_instance_id, stream, state_json) VALUES ('claude_code', 'inst_cc', 'sessions', '{}')"
    ).run();
    db.prepare(
      `INSERT INTO device_enrollment_codes (code_hash, owner_subject_id, connector_id, local_binding_id, created_at, expires_at)
       VALUES ('h', 'owner_local', 'google_takeout', 'b', ?, ?)`
    ).run(NOW, NOW);

    const changed = migrateRenamedConnectorIdsSqlite(db).changedRows;
    assert.ok(changed >= 4, `expected the seeded rows to change, got ${changed}`);

    assert.deepEqual(ids(db, "connectors"), ["claude-code"]);
    assert.deepEqual(ids(db, "connector_instances"), ["claude-code"]);
    assert.deepEqual(ids(db, "connector_state"), ["claude-code"]);
    assert.deepEqual(ids(db, "device_enrollment_codes"), ["google-takeout"]);
    const manifest = JSON.parse(
      String((db.prepare("SELECT manifest FROM connectors").get() as { manifest: string }).manifest)
    );
    assert.equal(manifest.connector_id, "claude-code");
    assert.equal(
      (db.prepare("SELECT display_name FROM connector_instances").get() as { display_name: string }).display_name,
      "claude-code",
      "a placeholder label equal to the old id follows the rename"
    );
    assert.equal(
      (db.prepare("SELECT connector_instance_id FROM connector_instances").get() as { connector_instance_id: string })
        .connector_instance_id,
      "inst_cc",
      "connection identity is not rewritten"
    );

    const before = Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    assert.equal(migrateRenamedConnectorIdsSqlite(db).changedRows, 0);
    assert.equal(Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n), before, "no write");
  })
);

test(
  "a store with no retired ids is left untouched",
  withDb((db) => {
    seedConnector(db, "claude-code");
    seedConnector(db, "codex");
    const before = Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    assert.equal(migrateRenamedConnectorIdsSqlite(db).changedRows, 0);
    assert.equal(Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n), before);
  })
);

test(
  "a manifest that names its connector only in storage_binding resolves to the new key after the rename",
  withDb((db) => {
    db.prepare("INSERT INTO connectors (connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
      "apple_photos",
      JSON.stringify({ storage_binding: { connector_id: "apple_photos", kind: "native" }, streams: [] }),
      NOW
    );
    migrateRenamedConnectorIdsSqlite(db);
    const manifest = JSON.parse(
      String((db.prepare("SELECT manifest FROM connectors").get() as { manifest: string }).manifest)
    );
    assert.equal(canonicalConnectorKeyFromManifest(manifest), "apple-photos");
    assert.equal(manifest.storage_binding.kind, "native", "the rest of the binding is kept");
  })
);

test(
  "a retired row that a current row already covers is deleted and counted; the current row wins",
  withDb((db) => {
    seedConnector(db, "claude_code");
    seedConnector(db, "claude-code");
    const record = (version: string) => JSON.stringify({ version });
    for (const id of ["claude_code", "claude-code"]) {
      db.prepare("INSERT INTO connector_installs (connector_id, record_json, updated_at) VALUES (?, ?, ?)").run(
        id,
        record(id),
        NOW
      );
    }
    const result = migrateRenamedConnectorIdsSqlite(db);
    assert.deepEqual(result.supersededRows, { connector_installs: 1, connectors: 1 });
    assert.match(String(describeConnectorIdRename(result)), SUPERSEDED_LOG);
    assert.deepEqual(ids(db, "connectors"), ["claude-code"]);
    const rows = db.prepare("SELECT connector_id, record_json FROM connector_installs").all() as {
      connector_id: string;
      record_json: string;
    }[];
    assert.deepEqual(rows, [{ connector_id: "claude-code", record_json: record("claude-code") }]);
  })
);

test(
  "a placeholder label follows the rename only on a connection of the renamed connector",
  withDb((db) => {
    seedConnector(db, "claude_code");
    seedConnector(db, "codex");
    seedInstance(db, "inst_cc", "claude_code", "binding-a");
    seedInstance(db, "inst_codex", "codex", "binding-b");
    db.prepare("UPDATE connector_instances SET display_name = 'claude_code'").run();
    migrateRenamedConnectorIdsSqlite(db);
    const labels = db
      .prepare("SELECT connector_instance_id, display_name FROM connector_instances ORDER BY connector_instance_id")
      .all();
    assert.deepEqual(labels, [
      { connector_instance_id: "inst_cc", display_name: "claude-code" },
      { connector_instance_id: "inst_codex", display_name: "claude_code" },
    ]);
  })
);

test(
  "a collision that cannot be resolved aborts and leaves every row as it was",
  withDb((db) => {
    seedConnector(db, "claude_code");
    seedConnector(db, "claude-code");
    // Same owner and binding under both ids: renaming one onto the other would merge two connections.
    seedInstance(db, "inst_old", "claude_code", "binding-a");
    seedInstance(db, "inst_new", "claude-code", "binding-a");
    assert.throws(() => migrateRenamedConnectorIdsSqlite(db), /UNIQUE/i);
    assert.deepEqual(ids(db, "connectors"), ["claude-code", "claude_code"]);
    assert.deepEqual(ids(db, "connector_instances"), ["claude-code", "claude_code"]);
  })
);

test(
  "every SQLite table keyed by connector id is one whose collision rule was decided",
  withDb((db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const keyedByConnector = tables
      .filter(({ name }) =>
        (db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all() as { name: string; pk: number }[]).some(
          (c) => Number(c.pk) > 0 && (c.name === "connector_id" || c.name === "connector_key")
        )
      )
      .map(({ name }) => name);
    assert.deepEqual(
      keyedByConnector,
      [
        "connector_accepted_declarations",
        "connector_activations",
        "connector_checkpoint_withholds",
        "connector_installs",
        "connector_lifecycle_locks",
        "connector_observation_runs",
        "connectors",
        "dataset_summary_stream_projection",
      ],
      "a new table keyed by connector id needs a precedence decision in connector-id-rename-migration.ts: its old-id rows are deleted on a key collision"
    );
  })
);

test("initDb renames retired ids stored in an existing database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-retired-ids-"));
  const path = join(dir, "pdpp.sqlite");
  try {
    let db = initDb(path);
    seedConnector(db, "apple_photos");
    seedInstance(db, "inst_ap", "apple_photos", "binding-a");
    closeDb();
    db = initDb(path);
    assert.deepEqual(ids(db, "connectors"), ["apple-photos"]);
    assert.deepEqual(ids(db, "connector_instances"), ["apple-photos"]);
    closeDb();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

const RENAMED: Readonly<Record<string, string>> = {
  apple_photos: "apple-photos",
  claude_code: "claude-code",
  google_messages: "google-messages",
  google_takeout: "google-takeout",
};
const renamed = (id: string): string => RENAMED[id] ?? id;

/** The read surface shared by the server's handle and a plain node:sqlite connection. */
interface Readable {
  prepare(sql: string): { all(...params: string[]): unknown[]; get(...params: string[]): unknown };
}

/** Ordinary tables (not virtual or FTS shadow tables), with whether each has a connector_id column. */
function plainTables(db: Readable): { name: string; hasConnectorId: boolean }[] {
  const tables = db
    .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return tables.map(({ name }) => ({
    hasConnectorId: (db.prepare("SELECT name FROM pragma_table_info(?)").all(name) as { name: string }[]).some(
      (column) => column.name === "connector_id"
    ),
    name,
  }));
}

/** Everything the upgrade must preserve, read from one store. */
function snapshot(db: Readable) {
  const rowCounts: Record<string, number> = {};
  const connectorIds: Record<string, string[]> = {};
  for (const { name, hasConnectorId } of plainTables(db)) {
    rowCounts[name] = Number((db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n);
    if (hasConnectorId) {
      connectorIds[name] = (
        db.prepare(`SELECT connector_id FROM "${name}" ORDER BY connector_id`).all() as { connector_id: string }[]
      ).map((row) => row.connector_id);
    }
  }
  const rows = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
  return {
    connectorIds,
    instances: rows("SELECT connector_instance_id, connector_id FROM connector_instances ORDER BY 1"),
    recordChanges: rows(
      "SELECT connector_id, connector_instance_id, stream, record_key, version, record_json FROM record_changes ORDER BY 2, 3, 5"
    ),
    records: rows(
      "SELECT connector_id, connector_instance_id, stream, record_key, version, record_json FROM records ORDER BY 2, 3, 4"
    ),
    rowCounts,
  };
}

const withRenamedIds = (rows: Record<string, unknown>[]) =>
  rows.map((row) => ({ ...row, connector_id: renamed(String(row.connector_id)) }));

test("first start upgrades a v0.9.9 store that holds the retired ids, losing only collided old-id rows", () => {
  // v0.9.9 is the last release before the rename; provenance.json says how the store was made.
  const fixture = new URL("./fixtures/connector-id-rename/v0.9.9-store.sqlite.gz", import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), "pdpp-v099-store-"));
  const path = join(dir, "pdpp.sqlite");
  try {
    writeFileSync(path, gunzipSync(readFileSync(fixture)));
    const original = new DatabaseSync(path, { readOnly: true });
    const before = snapshot(original);
    original.close();

    initDb(path);
    const after = snapshot(getDb());

    // Every retired id is renamed, and the only rows lost are the two old-id rows whose key a
    // current-id row already held: connectors (claude-code) and dataset_summary_stream_projection
    // (claude-code, sessions).
    const collided: Record<string, string> = {
      connectors: "claude-code",
      dataset_summary_stream_projection: "claude-code",
    };
    for (const [table, ids] of Object.entries(before.connectorIds)) {
      const expected = ids.map(renamed).sort();
      if (collided[table]) {
        expected.splice(expected.indexOf(collided[table]), 1);
      }
      assert.deepEqual(after.connectorIds[table], expected, table);
    }
    // Tables without a connector id lose nothing; first start may add bookkeeping rows to them
    // (for example a migration ledger entry).
    for (const [table, count] of Object.entries(before.rowCounts)) {
      if (!(table in before.connectorIds)) {
        assert.ok((after.rowCounts[table] ?? 0) >= count, `${table}: ${after.rowCounts[table]} < ${count}`);
      }
    }

    // The current-id row wins each collision; the lone old-id projection row is renamed.
    const db = getDb();
    const manifest = db.prepare("SELECT manifest FROM connectors WHERE connector_id = 'claude-code'").get() as {
      manifest: string;
    };
    assert.equal(JSON.parse(manifest.manifest).display_name, "current manifest");
    assert.deepEqual(
      db
        .prepare(
          "SELECT stream, record_count FROM dataset_summary_stream_projection WHERE connector_id = 'claude-code' ORDER BY stream"
        )
        .all(),
      [
        { record_count: 3, stream: "messages" },
        { record_count: 9, stream: "sessions" },
      ]
    );

    // Owner data keeps its connection, stream, key, version and content; only the id is renamed.
    assert.ok(before.records.length > 0 && before.recordChanges.length > 0, "the fixture holds owner records");
    assert.deepEqual(after.records, withRenamedIds(before.records));
    assert.deepEqual(after.recordChanges, withRenamedIds(before.recordChanges));
    assert.deepEqual(after.instances, withRenamedIds(before.instances));

    closeDb();
    initDb(path);
    assert.deepEqual(snapshot(getDb()), after, "a second start changes nothing");
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});
