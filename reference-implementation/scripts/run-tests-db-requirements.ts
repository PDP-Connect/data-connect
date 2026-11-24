// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Review each file and its imports before extending either set. Unknown files
// retain an outer database; this is not a filename/backend-name heuristic.
const NO_DATABASE = new Set([
  "test/backup-table-inventory.test.ts",
  "scripts/run-tests-file-concurrency-cap.test.ts",
  "scripts/run-tests-resource-policy.test.ts",
]);
const HELPER_OWNED = new Set([
  // Every database initialization is inside withTempDb -> withTemporaryPostgresDatabase.
  // Keep this file cold-required in postgres-template-eligibility.ts.
  "test/postgres-record-index-bootstrap.test.ts",
]);

export function needsOuterPostgresDatabase(file: string): boolean {
  return !(NO_DATABASE.has(file) || HELPER_OWNED.has(file));
}

export function needsPostgresRestoreDatabase(file: string): boolean {
  return file === "test/backup-table-inventory-postgres.test.ts";
}
