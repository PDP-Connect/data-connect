// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// SQLite-backend half of the backup table inventory suite. Split out of
// backup-table-inventory.test.ts so each entry declares exactly one backend:
// these three cases bootstrap a real SQLite database (initDb/getDb) or read a
// SQLite backup artifact with the sqlite3 CLI. The no-DB cases stay in
// backup-table-inventory.test.ts and the Postgres cases live in
// backup-table-inventory-postgres.test.ts. Case names and assertions are
// unchanged by the split.

import { strict as assert } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BACKUP_TABLE_INVENTORY,
  isInternalBackupCatalogTable,
  POSTGRES_STORAGE_TABLES,
  SQLITE_LAZY_STORAGE_TABLES,
  SQLITE_POSTGRES_ONLY_STORAGE_TABLES,
} from "../server/backup-table-policy.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function bootstrappedSqliteTables(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-backup-inventory-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    const rows = getDb()
      .prepare(
        `SELECT name
           FROM sqlite_schema
          WHERE type IN ('table', 'virtual table')
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .all<{ name: string }>();
    return rows.map((row) => row.name).filter((name) => !isInternalBackupCatalogTable(name));
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function sqliteQueryRows(path: string, sql: string): string[] {
  return execFileSync("sqlite3", ["-batch", "-noheader", path, sql], { encoding: "utf8" })
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);
}

function sqliteCatalogTables(path: string): string[] {
  return sqliteQueryRows(
    path,
    `SELECT name
       FROM sqlite_schema
      WHERE type IN ('table', 'virtual table')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name`
  ).filter((name) => !isInternalBackupCatalogTable(name));
}

function missingRequiredTables(restoredTables: Set<string>, lazyTables: ReadonlySet<string>): string[] {
  return Object.entries(BACKUP_TABLE_INVENTORY)
    .filter(([, entry]) => entry.classification === "backup_required")
    .map(([table]) => table)
    .filter((table) => !(restoredTables.has(table) || lazyTables.has(table)));
}

test("backup inventory classifies every bootstrapped SQLite catalog table", () => {
  const liveTables = new Set(bootstrappedSqliteTables());
  const classifiedTables = new Set(Object.keys(BACKUP_TABLE_INVENTORY));

  assert.deepEqual(
    sorted([...liveTables].filter((table) => !classifiedTables.has(table))),
    [],
    "every live table must be classified as backup_required, derived_rebuildable, or ephemeral_crash_reconciled"
  );
});

test("backup inventory has deterministic SQLite/Postgres table parity", () => {
  const sqliteTables = new Set([...bootstrappedSqliteTables(), ...SQLITE_LAZY_STORAGE_TABLES]);
  const postgresTables = new Set(POSTGRES_STORAGE_TABLES);

  assert.deepEqual(
    sorted([...sqliteTables].filter((table) => !postgresTables.has(table))),
    ["semantic_search_rowid"],
    "SQLite-only semantic rowid state must be the only static storage parity exception"
  );
  assert.deepEqual(
    sorted([...postgresTables].filter((table) => !sqliteTables.has(table))),
    sorted(SQLITE_POSTGRES_ONLY_STORAGE_TABLES),
    "Postgres storage table seam must not contain tables absent from bootstrapped SQLite beyond the declared Postgres-only exceptions"
  );
});

test("SQLite stopped backup preserves every required durable table", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-sqlite-backup-oracle-"));
  const sourcePath = join(dir, "source.sqlite");
  const backupPath = join(dir, "backup.sqlite");
  try {
    initDb(sourcePath);
    const source = getDb();
    source.prepare("INSERT INTO connectors(connector_id, manifest) VALUES (?, ?)").run("connector_backup", "{}");
    source
      .prepare(
        `INSERT INTO connector_instances(
          connector_instance_id, owner_subject_id, connector_id, display_name,
          source_kind, source_binding_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "cin_backup",
        "owner_backup",
        "connector_backup",
        "Backup",
        "account",
        "account_backup",
        "2026-08-12T00:00:00.000Z",
        "2026-08-12T00:00:00.000Z"
      );
    source
      .prepare(
        `INSERT INTO source_webhook_run_receipts(
          source_id, event_id, body_hash, connector_id, connector_instance_id,
          owner_subject_id, action, run_id, trace_id, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "source_backup",
        "evt_backup",
        "sha256:body",
        "connector_backup",
        "cin_backup",
        "owner_backup",
        "schedule_run",
        "run_backup",
        "trace_backup",
        "2026-08-12T00:00:00.000Z"
      );
    source
      .prepare(
        `INSERT INTO record_rejection_quota(owner_subject_id, pending_payload_bytes, pending_receipt_count)
         VALUES (?, ?, ?)`
      )
      .run("owner_backup", 7, 1);
    source
      .prepare(
        `INSERT INTO record_rejections(
          receipt_id, owner_subject_id, connector_instance_id, stream,
          connector_id, run_id, first_input_index, latest_input_index, reason_code,
          payload, payload_sha256, payload_bytes, replay_key, rejection_generation,
          created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "rr_backup",
        "owner_backup",
        "cin_backup",
        "messages",
        "connector_backup",
        "run_backup",
        0,
        0,
        "validation_error",
        Buffer.from("payload"),
        "sha256:fixture",
        7,
        "record-rejection-v2:fixture",
        "record-rejection-v2",
        "2026-08-12T00:00:00.000Z",
        "2026-08-12T00:00:00.000Z"
      );
    source.prepare("VACUUM INTO ?").run(backupPath);
    closeDb();

    const restoredTables = new Set(sqliteCatalogTables(backupPath));
    const missingTables = missingRequiredTables(
      restoredTables,
      new Set([...SQLITE_LAZY_STORAGE_TABLES, ...SQLITE_POSTGRES_ONLY_STORAGE_TABLES])
    );

    assert.deepEqual(sorted(missingTables), [], "SQLite backup artifact must contain every non-lazy required table");
    assert.equal(sqliteQueryRows(backupPath, "SELECT COUNT(*) FROM source_webhook_run_receipts")[0], "1");
    assert.equal(sqliteQueryRows(backupPath, "SELECT COUNT(*) FROM record_rejections")[0], "1");
    assert.equal(sqliteQueryRows(backupPath, "SELECT pending_payload_bytes FROM record_rejection_quota")[0], "7");
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});
