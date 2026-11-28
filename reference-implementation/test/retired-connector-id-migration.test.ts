// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { observationScenarios, seedObservationScenario, assertObservationScenario, collisionTables, seedCollision, assertCollision, bindingScenarios, seedBindingScenario, assertBindingScenario, key } from "./helpers/rename-collision-fixtures.ts";
import { createSqliteAcquisitionBatchStore } from "../server/stores/acquisition-batch-store.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import {
  HANDLED_CONNECTOR_UNIQUE_KEYS,
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

function seedBindingCollisions(db: Db): void {
  seedConnector(db, "claude_code");
  seedConnector(db, "claude-code");
  db.prepare(`INSERT INTO device_exporters
      (device_id, owner_subject_id, display_name, created_at, updated_at)
      VALUES ('dev', 'owner_local', 'device', ?, ?)`).run(NOW, NOW);
  for (const [id, connector] of [
    ["old", "claude_code"],
    ["new", "claude-code"],
  ] as const) {
    seedInstance(db, `inst_${id}`, connector, key("binding-a"));
    db.prepare(`INSERT INTO records
        (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at)
        VALUES (?, ?, 'sessions', 'record', ?, ?)`).run(connector, `inst_${id}`, JSON.stringify({ id }), NOW);
    db.prepare(`INSERT INTO device_source_instances
        (source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, created_at, updated_at)
        VALUES (?, 'dev', ?, ?, 'binding-a', ?, ?)`).run(`src_${id}`, connector, `inst_${id}`, NOW, NOW);
  }
}

test(
  "binding collisions preserve both instances, records and source identities",
  withDb((db) => {
    seedBindingCollisions(db);
    const currentInstance = db
      .prepare("SELECT * FROM connector_instances WHERE connector_instance_id = 'inst_new'")
      .get();
    const currentSource = db
      .prepare("SELECT * FROM device_source_instances WHERE source_instance_id = 'src_new'")
      .get();
    const result = migrateRenamedConnectorIdsSqlite(db);
    assert.deepEqual(result.disambiguatedRows, { connector_instances: 1, device_source_instances: 1 });
    assert.match(
      describeConnectorIdRename(result)!,
      /binding collisions disambiguated \(connector_instances: 1, device_source_instances: 1\)/
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM connector_instances WHERE connector_instance_id = 'inst_new'").get(),
      currentInstance
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM device_source_instances WHERE source_instance_id = 'src_new'").get(),
      currentSource
    );
    assert.equal(
      db.prepare("SELECT source_binding_key FROM connector_instances WHERE connector_instance_id = 'inst_old'").get()
        ?.source_binding_key,
      key("binding-a#renamed-from:claude_code")
    );
    assert.equal(
      db.prepare("SELECT local_binding_id FROM device_source_instances WHERE source_instance_id = 'src_old'").get()
        ?.local_binding_id,
      "binding-a#renamed-from:claude_code"
    );
    for (const id of ["old", "new"]) {
      assert.equal(
        db.prepare("SELECT record_json FROM records WHERE connector_instance_id = ?").get(`inst_${id}`)?.record_json,
        JSON.stringify({ id })
      );
    }
    assert.deepEqual(ids(db, "connector_instances"), ["claude-code", "claude-code"]);
    assert.deepEqual(ids(db, "device_source_instances"), ["claude-code", "claude-code"]);
    const before = Number(db.prepare("SELECT total_changes() AS n").get()?.n);
    assert.equal(migrateRenamedConnectorIdsSqlite(db).changedRows, 0);
    assert.equal(Number(db.prepare("SELECT total_changes() AS n").get()?.n), before);
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

test("startup preserves collided source bindings and records across two restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-binding-collision-"));
  const path = join(dir, "pdpp.sqlite");
  try {
    seedBindingCollisions(initDb(path));
    closeDb();
    for (let boot = 0; boot < 2; boot += 1) {
      const db = initDb(path);
      for (const id of ["old", "new"]) {
        assert.equal(
          db.prepare("SELECT record_json FROM records WHERE connector_instance_id = ?").get(`inst_${id}`)?.record_json,
          JSON.stringify({ id })
        );
        assert.equal(
          db
            .prepare("SELECT connector_instance_id FROM device_source_instances WHERE source_instance_id = ?")
            .get(`src_${id}`)?.connector_instance_id,
          `inst_${id}`
        );
      }
      assert.equal(
        db.prepare("SELECT local_binding_id FROM device_source_instances WHERE source_instance_id = 'src_old'").get()
          ?.local_binding_id,
        "binding-a#renamed-from:claude_code"
      );
      assert.equal(db.prepare("SELECT source_binding_key FROM connector_instances WHERE connector_instance_id = 'inst_old'").get()?.source_binding_key, key("binding-a#renamed-from:claude_code"));
      assert.notEqual(key("binding-a#renamed-from:claude_code"), db.prepare("SELECT source_binding_key FROM connector_instances WHERE connector_instance_id = 'inst_new'").get()?.source_binding_key);
      closeDb();
    }
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("unexpected unique collisions roll back and identify the migration, table and store", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-unknown-collision-"));
  const path = join(dir, "pdpp.sqlite");
  try {
    const db = initDb(path);
    db.exec("CREATE TABLE unexpected_bindings (id TEXT PRIMARY KEY, connector_id TEXT UNIQUE)");
    db.exec("INSERT INTO unexpected_bindings VALUES ('old', 'claude_code'), ('new', 'claude-code')");
    assert.throws(() => migrateRenamedConnectorIdsSqlite(db), /renamed_connector_ids_v2.*unexpected_bindings/);
    assert.deepEqual(ids(db, "unexpected_bindings"), ["claude-code", "claude_code"]);
    closeDb();
    assert.throws(
      () => initDb(path),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(path));
        assert.match(error.message, /renamed_connector_ids_v2.*unexpected_bindings/);
        return true;
      }
    );
  } finally {
    closeDb();
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

const ID_COLUMNS = new Set(["connector_id", "connector_key"]);

/** One row as a stable string over the given columns, blobs as hex, so two drivers' rows compare equal. */
function rowKey(row: Record<string, unknown>, columns: readonly string[]): string {
  return JSON.stringify(
    columns.map((column) => {
      const value = row[column];
      if (value instanceof Uint8Array) {
        return `blob:${Buffer.from(value).toString("hex")}`;
      }
      return typeof value === "bigint" ? Number(value) : value;
    })
  );
}

interface Table {
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * Every row of every ordinary table (not virtual or FTS shadow tables). `columns` limits a
 * table to the columns the old store had, so columns a later migration adds do not count.
 */
function snapshot(db: Readable, columnsOf: Record<string, Table> = {}): Record<string, Table> {
  const names = db
    .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const tables: Record<string, Table> = {};
  for (const { name } of names) {
    const columns =
      columnsOf[name]?.columns ??
      (db.prepare("SELECT name FROM pragma_table_info(?)").all(name) as { name: string }[]).map((c) => c.name).sort();
    tables[name] = { columns, rows: db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[] };
  }
  return tables;
}

function tableOf(tables: Record<string, Table>, name: string): Table {
  const table = tables[name];
  assert.ok(table, `${name} exists`);
  return table;
}

const keys = (table: Table): string[] => table.rows.map((row) => rowKey(row, table.columns)).sort();

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
    const after = snapshot(getDb(), before);

    // The only rows lost are the two old-id rows whose key a current-id row already held; the
    // current-id row wins.
    const collided: Record<string, (row: Record<string, unknown>) => boolean> = {
      connectors: (row) => row.connector_id === "claude_code",
      dataset_summary_stream_projection: (row) => row.connector_id === "claude_code" && row.stream === "sessions",
    };
    // First start records the migrations it ran.
    const bookkeeping = new Set(["storage_migration_ledger"]);
    // What the upgrade may change in a value: id columns, a connection named after its retired
    // id, and the id field inside a stored manifest.
    const upgraded = (name: string, row: Record<string, unknown>, column: string, value: unknown): unknown => {
      if (typeof value !== "string") {
        return value;
      }
      if (ID_COLUMNS.has(column)) {
        return renamed(value);
      }
      // A connection's label follows the rename only on a connection of the renamed connector.
      if (name === "connector_instances" && column === "display_name") {
        return renamed(String(row.connector_id)) === renamed(value) ? renamed(value) : value;
      }
      if (name === "connectors" && column === "manifest") {
        const manifest = JSON.parse(value) as { connector_id?: string };
        return JSON.stringify({ ...manifest, connector_id: renamed(String(manifest.connector_id)) });
      }
      return value;
    };
    // source_revision counts writes to a connection's rows, so renaming them advances it.
    // Compare it on its own below; every other column must be unchanged.
    const advancing: Record<string, string> = { connector_instances: "source_revision" };

    assert.ok(
      tableOf(before, "records").rows.length > 0 && tableOf(before, "record_changes").rows.length > 0,
      "the fixture holds owner records"
    );
    assert.ok(before.storage_migration_ledger, "the fixture holds a migration ledger");
    // A table first start creates holds no rows, so nothing escapes the comparison below.
    const created = Object.keys(after).filter((name) => !before[name] && tableOf(after, name).rows.length > 0);
    assert.deepEqual(created, [], "first start fills no table the old store lacked");
    for (const [name, table] of Object.entries(before)) {
      // Every column of every row is unchanged, except that each retired id is renamed.
      const columns = table.columns.filter((column) => column !== advancing[name]);
      const expected: Table = {
        columns,
        rows: table.rows
          .filter((row) => !collided[name]?.(row))
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([column, value]) => [column, upgraded(name, row, column, value)])
            )
          ),
      };
      const got: Table = { columns, rows: tableOf(after, name).rows };
      if (bookkeeping.has(name)) {
        const present = new Set(keys(got));
        assert.deepEqual(keys(expected).filter((key) => !present.has(key)), [], name);
      } else {
        assert.deepEqual(keys(got), keys(expected), name);
      }
    }

    const revisions = (tables: Record<string, Table>) =>
      new Map(
        tableOf(tables, "connector_instances").rows.map((row) => [
          String(row.connector_instance_id),
          Number(row.source_revision),
        ])
      );
    const revisionsBefore = revisions(before);
    for (const [id, revision] of revisions(after)) {
      assert.ok(revision >= (revisionsBefore.get(id) ?? 0), `${id}: source_revision went back`);
    }

    // The winning rows are the current-id ones: the current manifest, and 9 sessions rather than 7.
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

    closeDb();
    initDb(path);
    const again = snapshot(getDb(), before);
    for (const [name, table] of Object.entries(after)) {
      assert.deepEqual(keys(again[name] ?? { columns: [], rows: [] }), keys(table), `a second start changes nothing in ${name}`);
    }
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

for (const scenario of [...collisionTables, ...bindingScenarios, ...observationScenarios]) {
  test(`startup collision: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-rename-collision-"));
    const path = join(dir, "fixture.sqlite");
    let db = initDb(path);
    const query = async (sql: string) => /^SELECT/i.test(sql) ? db.prepare(sql).all() as Record<string, unknown>[] : (db.exec(sql), []);
    try {
      if ((collisionTables as readonly string[]).includes(scenario)) await seedCollision(query, scenario);
      else if ((observationScenarios as readonly string[]).includes(scenario)) await seedObservationScenario(query, scenario);
      else await seedBindingScenario(query, scenario);
      closeDb();
      let snapshot: string | undefined;
      for (let boot = 0; boot < 2; boot++) {
        db = initDb(path);
        if ((collisionTables as readonly string[]).includes(scenario)) await assertCollision(query, scenario);
        else if ((observationScenarios as readonly string[]).includes(scenario)) await assertObservationScenario(query, scenario);
        else await assertBindingScenario(query, scenario);
        if (scenario === "acquisition_batches") assert.equal(createSqliteAcquisitionBatchStore().findByArtifactHash("owner_local", "claude-code", "same-digest")?.batchId, "batch_new");
        const state = JSON.stringify(await query(`SELECT * FROM ${(collisionTables as readonly string[]).includes(scenario) ? scenario : "device_source_instances"}`));
        if (snapshot) assert.equal(state, snapshot);
        snapshot = state;
        closeDb();
      }
    } finally { closeDb(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("every non-primary UNIQUE index containing connector_id has a collision policy", withDb(db => {
  const found: string[] = [];
  for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    const name = String(table.name).replaceAll('"', '""');
    for (const index of db.prepare(`PRAGMA index_list("${name}")`).all()) {
      if (!index.unique || index.origin === "pk") continue;
      const cols = db.prepare(`PRAGMA index_info("${String(index.name).replaceAll('"', '""')}")`).all().map(row => String(row.name ?? ""));
      if (cols.includes("connector_id")) found.push(`${name}:${cols.sort().join(",")}`);
    }
  }
  assert.deepEqual(found.sort(), [...HANDLED_CONNECTOR_UNIQUE_KEYS].sort());
}));
