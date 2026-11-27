// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  describeConnectorIdRename,
  migrateRenamedConnectorIdsSqlite,
} from "../server/connector-id-rename-migration.ts";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { SqliteDriver } from "../server/sqlite-driver.ts";

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

test("first start upgrades a v0.9.9 store that holds the retired ids, losing only collided old-id rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-v099-connector-ids-"));
  const quote = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';
  const retired = ["apple_photos", "claude_code", "google_messages", "google_takeout"];
  type ReadableDb = Pick<Db, "prepare">;
  function inspectTables<T>(db: ReadableDb, inspect: (table: string) => T): Record<string, T> {
    const kinds = db.prepare("PRAGMA table_list").all() as { schema: string; name: string; type: string }[];
    const byName = new Map(kinds.filter(row => row.schema === "main").map(row => [row.name, row.type]));
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[];
    const result: Record<string, T> = {};
    for (const { name } of tables) {
      try {
        result[name] = inspect(quote(name));
      } catch (error) {
        const kind = byName.get(name);
        if (kind !== "virtual" && kind !== "shadow") throw error;
      }
    }
    return result;
  }
  const rowCounts = (db: ReadableDb) => inspectTables(db, table =>
    (db.prepare("SELECT count(*) AS n FROM " + table).get() as { n: number }).n);
  const countsByConnector = (db: Db, name: string) => Object.fromEntries(
    (db.prepare("SELECT connector_id, count(*) AS n FROM " + quote(name) + " GROUP BY connector_id").all()
      as { connector_id: string; n: number }[]).map(row => [row.connector_id, row.n]),
  );
  try {
    const bytes = gunzipSync(readFileSync(new URL("./fixtures/connector-id-rename/v0.9.9-store.sqlite.gz", import.meta.url)));
    const beforePath = join(dir, "before.sqlite");
    const upgradePath = join(dir, "upgrade.sqlite");
    writeFileSync(beforePath, bytes);
    writeFileSync(upgradePath, bytes);
    const original = new SqliteDriver(beforePath, { readonly: true, fileMustExist: true });
    let before: Record<string, number>;
    try { before = rowCounts(original); } finally { original.close(); }

    closeDb();
    initDb(upgradePath);
    const db = getDb();
    const retained = inspectTables(db, table => {
      const columns = db.prepare("PRAGMA table_info(" + table + ")").all() as { name: string }[];
      return columns.filter(({ name }) => name === "connector_id" || name === "connector_key").flatMap(({ name }) =>
        db.prepare("SELECT " + quote(name) + " FROM " + table + " WHERE " + quote(name) + " IN (?, ?, ?, ?)")
          .all(...retired));
    });
    for (const [table, rows] of Object.entries(retained)) assert.deepEqual(rows, [], table);

    const expected = {
      connectors: { "apple-photos": 1, "claude-code": 1, "google-takeout": 1 },
      connector_installs: { "apple-photos": 1 },
      connector_accepted_declarations: { "google-messages": 1 },
      dataset_summary_stream_projection: { "claude-code": 2 },
      connector_instances: { "apple-photos": 1, "claude-code": 1 },
      connector_state: { "claude-code": 1 },
      records: { "apple-photos": 1, "claude-code": 3 },
      record_changes: { "apple-photos": 1, "claude-code": 3 },
      version_counter: { "apple-photos": 1, "claude-code": 2 },
      run_history: { "claude-code": 1 },
      device_enrollment_codes: { "google-messages": 1 },
    };
    for (const [table, counts] of Object.entries(expected)) assert.deepEqual(countsByConnector(db, table), counts, table);

    const connector = db.prepare("SELECT manifest FROM connectors WHERE connector_id = ?").get("claude-code") as { manifest: string };
    assert.equal(JSON.parse(connector.manifest).display_name, "current manifest");
    assert.deepEqual(
      db.prepare("SELECT stream, record_count FROM dataset_summary_stream_projection WHERE connector_id = ? ORDER BY stream")
        .all("claude-code"),
      [{ stream: "messages", record_count: 3 }, { stream: "sessions", record_count: 9 }],
    );
    const keys = db.prepare("SELECT record_key FROM records").all() as { record_key: string }[];
    assert.deepEqual(new Set(keys.map(row => row.record_key)), new Set(["s1", "s2", "m1", "p1"]));
    for (const table of ["connector_instances", "records", "record_changes"]) {
      const rows = db.prepare("SELECT DISTINCT connector_instance_id FROM " + quote(table)).all() as { connector_instance_id: string }[];
      assert.deepEqual(new Set(rows.map(row => row.connector_instance_id)), new Set(["cin_old_claude", "cin_old_photos"]), table);
    }

    const after = rowCounts(db);
    for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const collided = table === "connectors" || table === "dataset_summary_stream_projection";
      assert.equal(after[table] ?? 0, (before[table] ?? 0) - (collided ? 1 : 0), table);
    }
    closeDb();
    initDb(upgradePath);
    assert.deepEqual(rowCounts(getDb()), after, "a second start changes no table counts");
    for (const [table, counts] of Object.entries(expected)) {
      assert.deepEqual(countsByConnector(getDb(), table), counts, table);
    }
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
