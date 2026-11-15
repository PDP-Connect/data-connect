// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  currentKeyForRetiredConnectorId,
  migrateRetiredConnectorIdsSqlite,
  RETIRED_CONNECTOR_IDS,
  unknownConnectorMessage,
} from "../server/retired-connector-ids.ts";

type Db = ReturnType<typeof getDb>;

const NOW = "2026-11-14T00:00:00.000Z";

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

test("retired ids map to the manifest keys of the four underscore-spelled connectors", () => {
  assert.deepEqual(RETIRED_CONNECTOR_IDS, {
    apple_photos: "apple-photos",
    claude_code: "claude-code",
    google_messages: "google-messages",
    google_takeout: "google-takeout",
  });
  assert.equal(currentKeyForRetiredConnectorId(" claude_code "), "claude-code");
  assert.equal(currentKeyForRetiredConnectorId("claude-code"), null);
  assert.equal(currentKeyForRetiredConnectorId("toString"), null);
  assert.equal(unknownConnectorMessage("claude_code"), "Unknown connector: claude_code. This id was renamed; use claude-code.");
  assert.equal(unknownConnectorMessage("nope"), "Unknown connector: nope");
});

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

    const changed = migrateRetiredConnectorIdsSqlite(db);
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
    assert.equal(migrateRetiredConnectorIdsSqlite(db), 0);
    assert.equal(Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n), before, "no write");
  })
);

test(
  "a store with no retired ids is left untouched",
  withDb((db) => {
    seedConnector(db, "claude-code");
    seedConnector(db, "codex");
    const before = Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    assert.equal(migrateRetiredConnectorIdsSqlite(db), 0);
    assert.equal(Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n), before);
  })
);

test(
  "a retired row that a current row already covers is dropped; the current row wins",
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
    migrateRetiredConnectorIdsSqlite(db);
    assert.deepEqual(ids(db, "connectors"), ["claude-code"]);
    const rows = db.prepare("SELECT connector_id, record_json FROM connector_installs").all() as {
      connector_id: string;
      record_json: string;
    }[];
    assert.deepEqual(rows, [{ connector_id: "claude-code", record_json: record("claude-code") }]);
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
    assert.throws(() => migrateRetiredConnectorIdsSqlite(db), /UNIQUE/i);
    assert.deepEqual(ids(db, "connectors"), ["claude-code", "claude_code"]);
    assert.deepEqual(ids(db, "connector_instances"), ["claude-code", "claude_code"]);
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
