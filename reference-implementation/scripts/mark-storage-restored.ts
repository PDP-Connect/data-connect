#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The storage-epoch restore step. Run it after restoring a database backup and
 * before the server serves requests.
 *
 * A restore can regress the run sequences the server issued, the run-order
 * marker and the coverage proof tables, so a restored proof could otherwise
 * read as current again. This step starts a new storage epoch for every
 * connection (server/stores/collection-revision-store.ts,
 * `beginStorageEpochAfterRestore`): no proof committed before it can be current
 * until a run issued after it commits a new one. It also increments the config
 * pointer's storage epoch, which is documented for the same event.
 *
 * A restore that skips this step is not detected. See
 * docs/261021-local-device-coverage-evidence.md, "Run order and commit order".
 *
 * Usage (from reference-implementation/):
 *   node --import tsx scripts/mark-storage-restored.ts --db <path to the SQLite database>
 *   PDPP_DATABASE_URL=<postgres url> node --import tsx scripts/mark-storage-restored.ts
 */

import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { beginStorageEpochAfterRestore } from "../server/stores/collection-revision-store.ts";

async function main(argv: readonly string[]): Promise<void> {
  const databaseUrl = process.env.PDPP_DATABASE_URL;
  const dbFlag = argv.indexOf("--db");
  const dbPath = dbFlag >= 0 ? argv[dbFlag + 1] : undefined;
  if (!(databaseUrl || dbPath)) {
    throw new Error("Usage: mark-storage-restored.ts --db <sqlite path>, or set PDPP_DATABASE_URL for PostgreSQL");
  }
  if (databaseUrl) {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl } as Parameters<typeof initPostgresStorage>[0]);
  } else {
    initDb(dbPath);
  }
  try {
    const { connections } = await beginStorageEpochAfterRestore();
    process.stdout.write(`storage epoch advanced for ${connections} connection(s)\n`);
  } finally {
    if (databaseUrl) {
      await closePostgresStorage();
    }
    closeDb();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
