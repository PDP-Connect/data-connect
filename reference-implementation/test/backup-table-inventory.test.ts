// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Backend-independent half of the backup table inventory suite. These five
// cases read source files, docs and the static backup/migration policy
// exports; none of them opens a database, so this entry has no backend and
// runs once. The SQLite cases live in backup-table-inventory-sqlite.test.ts
// and the Postgres cases in backup-table-inventory-postgres.test.ts. Case
// names and assertions are unchanged by the split; the database imports and
// fixtures the moved cases used were removed with them, which is what lets
// this file run without any database.

import { strict as assert } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DERIVED_TABLES, SKIP_TABLES, TABLES } from "../scripts/migrate-storage/schema.ts";
import { BACKUP_TABLE_INVENTORY, isInternalBackupCatalogTable } from "../server/backup-table-policy.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const SERVER_SOURCE_FILE_RE = /\.(?:js|sql|ts)$/;
const CREATE_TABLE_NAME_RE = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)\s*[(]/gi;
const BACKUP_POLICY_PATH_RE = /server\/backup-table-policy\.ts/;
const LOGICAL_MIGRATION_SUBSET_RE = /logical migration subset/i;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(path);
    }
    return SERVER_SOURCE_FILE_RE.test(entry.name) ? [path] : [];
  });
}

test("backup inventory accounts for store-created table DDL outside bootstrap", () => {
  const classifiedTables = new Set(Object.keys(BACKUP_TABLE_INVENTORY));
  const createdTables = new Set<string>();
  for (const path of walkFiles(join(repoRoot, "reference-implementation/server"))) {
    const source = readFileSync(path, "utf8");
    for (const [, tableName] of source.matchAll(CREATE_TABLE_NAME_RE)) {
      if (tableName && !tableName.endsWith("_new") && tableName !== "scheduler_run_history") {
        createdTables.add(tableName);
      }
    }
  }

  assert.deepEqual(
    sorted([...createdTables].filter((table) => !(isInternalBackupCatalogTable(table) || classifiedTables.has(table)))),
    [],
    "store-created application tables must also be classified"
  );
});

test("non-required backup classifications require executable proof", () => {
  const unprovedNonRequiredTables = Object.entries(BACKUP_TABLE_INVENTORY)
    .filter(([, entry]) => entry.classification !== "backup_required")
    .map(([table]) => table);

  assert.deepEqual(
    sorted(unprovedNonRequiredTables),
    [],
    "tables without a named executable rebuild/reconcile oracle must remain backup_required"
  );
});

test("migration schema exports load and preserve the logical migration subset", () => {
  const tableNames = TABLES.map((table) => table.name);

  assert(tableNames.includes("records"), "migration schema should parse canonical tables");
  assert(DERIVED_TABLES.has("lexical_search_index"), "derived migration set should load");
  assert.equal(SKIP_TABLES, DERIVED_TABLES, "skip table export must alias the derived migration set");
  assert.deepEqual(
    TABLES.filter((table) => table.skipMigration).map((table) => table.name),
    tableNames.filter((table) => DERIVED_TABLES.has(table)),
    "derived migration tables must be the only skipped logical migration tables"
  );
});

test("storage migration inventory does not imply complete backup coverage", () => {
  const migratedTables = new Set(TABLES.filter((table) => !table.skipMigration).map((table) => table.name));
  const backupRequiredTables = Object.entries(BACKUP_TABLE_INVENTORY)
    .filter(([, entry]) => entry.classification === "backup_required")
    .map(([table]) => table);
  const backupRequiredNotMigrated = backupRequiredTables.filter((table) => !migratedTables.has(table));

  assert(backupRequiredNotMigrated.length > 0, "guard fixture must prove migration is a subset, not a full backup");
});

test("migration docs identify the backup policy API without claiming complete backup coverage", () => {
  const migrateDoc = readFileSync(join(repoRoot, "reference-implementation/docs/migrate-storage.md"), "utf8");
  assert.match(migrateDoc, BACKUP_POLICY_PATH_RE);
  assert.match(migrateDoc, LOGICAL_MIGRATION_SUBSET_RE);
});
