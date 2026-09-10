// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Postgres-backend half of the backup table inventory suite. Split out of
// backup-table-inventory.test.ts so each entry declares exactly one backend:
// these three cases require a real Postgres server (PDPP_TEST_POSTGRES_URL)
// and drive pg_dump/psql against it. The no-DB cases stay in
// backup-table-inventory.test.ts and the SQLite cases live in
// backup-table-inventory-sqlite.test.ts. Case names and assertions are
// unchanged by the split, including the existing URL-absent skip guards --
// replacing those skips with failure where Postgres is required is a
// scheduling change, not part of this split.

import { strict as assert } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BACKUP_TABLE_INVENTORY,
  POSTGRES_LAZY_STORAGE_TABLES,
  POSTGRES_SQLITE_ONLY_STORAGE_TABLES,
  POSTGRES_STORAGE_TABLES,
} from "../server/backup-table-policy.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  withPostgresReadOnlyTransaction,
} from "../server/postgres-storage.ts";
import { provisionTestDatabase, TEST_DATABASE_SENTINEL_SCHEMA } from "../server/postgres-test-database-guard.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_VERSION_RE = /PostgreSQL\)\s+(\d+)\./;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function missingRequiredTables(restoredTables: Set<string>, lazyTables: ReadonlySet<string>): string[] {
  return Object.entries(BACKUP_TABLE_INVENTORY)
    .filter(([, entry]) => entry.classification === "backup_required")
    .map(([table]) => table)
    .filter((table) => !(restoredTables.has(table) || lazyTables.has(table)));
}

function postgresTool(tool: "pg_dump" | "psql", args: string[]): void {
  const image = process.env.PDPP_TEST_POSTGRES_CLIENT_IMAGE;
  if (image) {
    execFileSync("docker", ["run", "--rm", "--network", "host", image, tool, ...args], { stdio: "inherit" });
    return;
  }
  execFileSync(tool, args, { stdio: "inherit" });
}

function postgresToolOutput(tool: "pg_dump" | "psql", args: string[]): string {
  const image = process.env.PDPP_TEST_POSTGRES_CLIENT_IMAGE;
  if (image) {
    return execFileSync("docker", ["run", "--rm", "--network", "host", image, tool, ...args], { encoding: "utf8" });
  }
  return execFileSync(tool, args, { encoding: "utf8" });
}

function postgresToolWithInput(tool: "psql", args: string[], input: string): void {
  const image = process.env.PDPP_TEST_POSTGRES_CLIENT_IMAGE;
  if (image) {
    execFileSync("docker", ["run", "--rm", "--interactive", "--network", "host", image, tool, ...args], {
      input,
      stdio: ["pipe", "inherit", "inherit"],
    });
    return;
  }
  execFileSync(tool, args, { input, stdio: ["pipe", "inherit", "inherit"] });
}

function postgresClientMajor(tool: "pg_dump" | "psql"): number {
  const output = postgresToolOutput(tool, ["--version"]);
  const match = POSTGRES_VERSION_RE.exec(output);
  assert(match, `could not parse ${tool} version from ${output}`);
  return Number(match[1]);
}

function postgresServerMajor(url: string): number {
  const version = postgresToolOutput("psql", [url, "-At", "-c", "SHOW server_version_num;"]).trim();
  return Math.floor(Number(version) / 10_000);
}

function assertPostgresDumpClientCompatible(url: string): void {
  const serverMajor = postgresServerMajor(url);
  const dumpMajor = postgresClientMajor("pg_dump");
  const psqlMajor = postgresClientMajor("psql");

  assert.equal(
    dumpMajor,
    serverMajor,
    `pg_dump major ${dumpMajor} must match PostgreSQL server major ${serverMajor}; set PDPP_TEST_POSTGRES_CLIENT_IMAGE=postgres:${serverMajor}-alpine or equivalent`
  );
  assert.equal(
    psqlMajor,
    serverMajor,
    `psql major ${psqlMajor} must match PostgreSQL server major ${serverMajor}; set PDPP_TEST_POSTGRES_CLIENT_IMAGE=postgres:${serverMajor}-alpine or equivalent`
  );
}

test("backup inventory matches a bootstrapped Postgres catalog when configured", async (t) => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  if (!url) {
    t.skip("PDPP_TEST_POSTGRES_URL is not set");
    return;
  }
  await initPostgresStorage({ backend: "postgres", databaseUrl: url });
  try {
    const actualTables = await withPostgresReadOnlyTransaction(async (client) => {
      const result = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_type = 'BASE TABLE'
          ORDER BY table_name`
      );
      return result.rows.map((row) => row.table_name);
    });
    const actualAndLazyTables = new Set([...actualTables, ...POSTGRES_LAZY_STORAGE_TABLES]);
    assert.deepEqual(sorted(actualAndLazyTables), sorted(POSTGRES_STORAGE_TABLES));
  } finally {
    await closePostgresStorage();
  }
});

test("Postgres dump/restore preserves every required durable table when configured", async (t) => {
  const sourceUrl = process.env.PDPP_TEST_POSTGRES_URL;
  const restoreUrl = process.env.PDPP_TEST_POSTGRES_RESTORE_URL;
  if (!(sourceUrl && restoreUrl)) {
    t.skip("PDPP_TEST_POSTGRES_URL and PDPP_TEST_POSTGRES_RESTORE_URL are not both set");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "pdpp-postgres-backup-oracle-"));
  const dumpPath = join(dir, "backup.sql");
  try {
    assertPostgresDumpClientCompatible(sourceUrl);
    assertPostgresDumpClientCompatible(restoreUrl);

    postgresTool("psql", [
      sourceUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
    ]);
    await initPostgresStorage({ backend: "postgres", databaseUrl: sourceUrl });
    await closePostgresStorage();

    // Exclude the test-guard schema from the dump: pg_dump with no --schema
    // filter captures every schema in the source database, including
    // pdpp_test_guard (stamped by provisionTestDatabase so this run's own
    // sentinel survives a `DROP SCHEMA public CASCADE`). The dump's bare
    // `CREATE SCHEMA pdpp_test_guard;` (no IF NOT EXISTS) then collides with
    // the restore target's own sentinel, which must already exist there for
    // the restore database to be admissible in the first place. The guard
    // schema is test-harness bookkeeping, not durable product data, so
    // dropping it from the dump changes nothing this test verifies -- the
    // restore target's sentinel is independently proven by its own
    // provisioning, never by anything this dump carries.
    const dumpSql = postgresToolOutput("pg_dump", [
      "--no-owner",
      "--no-privileges",
      `--exclude-schema=${TEST_DATABASE_SENTINEL_SCHEMA}`,
      sourceUrl,
    ]);
    writeFileSync(dumpPath, dumpSql);
    postgresTool("psql", [
      restoreUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
    ]);
    postgresToolWithInput("psql", [restoreUrl, "-v", "ON_ERROR_STOP=1"], dumpSql);

    await initPostgresStorage({ backend: "postgres", databaseUrl: restoreUrl });
    try {
      const restoredTables = await withPostgresReadOnlyTransaction(async (client) => {
        const result = await client.query<{ table_name: string }>(
          `SELECT table_name
             FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_type = 'BASE TABLE'
            ORDER BY table_name`
        );
        return new Set(result.rows.map((row) => row.table_name));
      });
      const missingTables = missingRequiredTables(
        restoredTables,
        new Set([...POSTGRES_LAZY_STORAGE_TABLES, ...POSTGRES_SQLITE_ONLY_STORAGE_TABLES])
      );

      assert.deepEqual(sorted(missingTables), [], "Postgres dump/restore must contain every non-lazy required table");
    } finally {
      await closePostgresStorage();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Postgres dump/restore succeeds against a restore target that already carries its own test-guard sentinel", async (t) => {
  const sourceUrl = process.env.PDPP_TEST_POSTGRES_URL;
  if (!sourceUrl) {
    t.skip("PDPP_TEST_POSTGRES_URL is not set");
    return;
  }

  // Regression oracle for the incident this fix addresses: a real gate run
  // reuses a persistent PDPP_TEST_POSTGRES_RESTORE_URL across invocations, so
  // the restore target already carries its own pdpp_test_guard sentinel
  // (stamped by an earlier run or by operator setup -- it must, or
  // initPostgresStorage would refuse it as unprovisioned). This test builds
  // that exact precondition -- a disposable database pre-stamped with the
  // sentinel via provisionTestDatabase, standing in for the persistent
  // restore target -- and proves the dump/restore no longer collides on
  // `CREATE SCHEMA pdpp_test_guard`, without ever dropping or bypassing the
  // restore target's own sentinel (assertTestDatabase below re-verifies it
  // survived, independent of anything the dump carried).
  const dir = mkdtempSync(join(tmpdir(), "pdpp-postgres-backup-guard-collision-"));
  const dumpPath = join(dir, "backup.sql");
  try {
    await withTemporaryPostgresDatabase(
      {
        connectionString: sourceUrl,
        databaseName: `pdpp_backup_guard_collision_src_${randomBytes(6).toString("hex")}`,
      },
      async (freshSourceUrl) => {
        await withTemporaryPostgresDatabase(
          {
            connectionString: sourceUrl,
            databaseName: `pdpp_backup_guard_collision_dst_${randomBytes(6).toString("hex")}`,
          },
          async (preStampedRestoreUrl) => {
            // withTemporaryPostgresDatabase already provisions freshSourceUrl
            // with the sentinel; provision the restore target too so it
            // independently carries its own sentinel (already true here, but
            // explicit provisioning models "a persistent restore DB that was
            // stamped in a prior run" rather than "this run's own callback
            // provisioning", matching the real gate's actual precondition).
            await provisionTestDatabase(preStampedRestoreUrl);

            await initPostgresStorage({ backend: "postgres", databaseUrl: freshSourceUrl });
            await closePostgresStorage();

            const dumpSql = postgresToolOutput("pg_dump", [
              "--no-owner",
              "--no-privileges",
              `--exclude-schema=${TEST_DATABASE_SENTINEL_SCHEMA}`,
              freshSourceUrl,
            ]);
            writeFileSync(dumpPath, dumpSql);

            postgresTool("psql", [
              preStampedRestoreUrl,
              "-v",
              "ON_ERROR_STOP=1",
              "-c",
              "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
            ]);
            // This is the exact statement that failed before the fix: replaying
            // a dump onto a restore target whose pdpp_test_guard schema already
            // exists. Success here is the regression proof.
            postgresToolWithInput("psql", [preStampedRestoreUrl, "-v", "ON_ERROR_STOP=1"], dumpSql);

            await initPostgresStorage({ backend: "postgres", databaseUrl: preStampedRestoreUrl });
            try {
              const restoredTables = await withPostgresReadOnlyTransaction(async (client) => {
                const result = await client.query<{ table_name: string }>(
                  `SELECT table_name
                     FROM information_schema.tables
                    WHERE table_schema = current_schema()
                      AND table_type = 'BASE TABLE'
                    ORDER BY table_name`
                );
                return new Set(result.rows.map((row) => row.table_name));
              });
              const missingTables = missingRequiredTables(
                restoredTables,
                new Set([...POSTGRES_LAZY_STORAGE_TABLES, ...POSTGRES_SQLITE_ONLY_STORAGE_TABLES])
              );
              assert.deepEqual(
                sorted(missingTables),
                [],
                "restore onto a pre-guarded target must still contain every non-lazy required table"
              );
            } finally {
              await closePostgresStorage();
            }
          }
        );
      }
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
