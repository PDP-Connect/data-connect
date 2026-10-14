// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy-upgrade preservation on Postgres, where the storage is the point:
 * instances, per-instance state, grants and records. The scenarios are the
 * ones in legacy-upgrade-preservation.test.ts (shared via
 * test/helpers/legacy-upgrade.ts), run against the Postgres adapters.
 *
 * Gated on the dedicated loopback test database (PDPP_TEST_POSTGRES_URL); when
 * it is absent each case registers as skipped.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import {
  assertUpdatePreservesOwnerRows,
  assertUpdateWithoutCatalogEntryCreatesNothing,
  postgresBackend,
} from "./helpers/legacy-upgrade.ts";

const DATABASE_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const OWNER_TABLES = "TRUNCATE connectors, connector_instances, grants, records, connector_state CASCADE";
const SKIP = DATABASE_URL ? false : "dedicated PDPP_TEST_POSTGRES_URL unset";

async function withFreshPostgres(label: string, body: (dataDir: string, databaseUrl: string) => Promise<void>) {
  const databaseUrl = DATABASE_URL as string;
  const dir = mkdtempSync(join(tmpdir(), `pdpp-legacy-pg-${label}-`));
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    // The per-file database is dedicated to this file; start each case from empty owner tables.
    await postgresQuery(OWNER_TABLES);
    await body(join(dir, "data"), databaseUrl);
  } finally {
    // The test-database guard refuses a database that still holds records at admission.
    await postgresQuery(OWNER_TABLES).catch(() => undefined);
    await closePostgresStorage();
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

test("Postgres: /update over HTTP on a legacy-registered github changes only the manifest and manifest_generation", {
  skip: SKIP,
}, async () => {
  await withFreshPostgres("update", (dataDir, databaseUrl) =>
    assertUpdatePreservesOwnerRows(postgresBackend, dataDir, databaseUrl)
  );
});

test("Postgres: /update with a key that has no catalog entry fails and creates no rows", {
  skip: SKIP,
}, async () => {
  await withFreshPostgres("update-missing", (dataDir, databaseUrl) =>
    assertUpdateWithoutCatalogEntryCreatesNothing(postgresBackend, dataDir, databaseUrl)
  );
});
