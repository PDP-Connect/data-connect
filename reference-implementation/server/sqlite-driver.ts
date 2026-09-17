// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one place the SQLite native driver is resolved.
 *
 * The desktop vault is encrypted at rest, so the reference implementation
 * links `better-sqlite3-multiple-ciphers` rather than stock `better-sqlite3`.
 * Both packages exist in the dependency tree and expose the same API, which
 * makes them easy to confuse -- and confusing them is not a type error, it is
 * a silent correctness failure:
 *
 *   - They are SEPARATE native addons. `Database.prototype` is a different
 *     object in each, so a test that patches `prepare()` on one observes
 *     nothing when production prepares on the other.
 *   - They link SEPARATE copies of SQLite. SQLite serializes same-file access
 *     within a process through a per-library inode lock table, because POSIX
 *     advisory locks do not conflict between two descriptors held by the same
 *     process. Two linked copies keep two tables, so two connections opened
 *     from different packages onto the same file DO NOT contend: a sibling
 *     `BEGIN IMMEDIATE` never sees SQLITE_BUSY while the other holds the write
 *     lock. (Across a process boundary the locks work normally -- this is a
 *     same-process artifact, not a defect in either build.)
 *
 * So every connection in a given process -- production, test harness, seeding
 * fixture, migration script -- must come from the SAME package. Import
 * `SqliteDriver` from here instead of naming a driver package directly;
 * `test/sqlite-driver-single-source.test.ts` enforces that structurally.
 */

import { createRequire } from "node:module";
import type { SqliteEncryptionDatabaseConstructor } from "./sqlite-encryption.ts";

/** The SQLite driver package this implementation links, named exactly once. */
export const SQLITE_DRIVER_MODULE = "better-sqlite3-multiple-ciphers";

/**
 * The driver package that must NOT be loaded alongside {@link SQLITE_DRIVER_MODULE}.
 * It stays in the dependency tree for its TypeScript types, which the cipher
 * build does not ship.
 */
export const FORBIDDEN_SQLITE_DRIVER_MODULE = "better-sqlite3";

/**
 * The `better-sqlite3`-compatible constructor, loaded once per process.
 *
 * Typed as the encryption-aware constructor (`key`/`rekey` included) because
 * that is what the cipher build actually provides; callers that only need the
 * stock surface can narrow it themselves.
 */
export const SqliteDriver = createRequire(import.meta.url)(
	SQLITE_DRIVER_MODULE,
) as SqliteEncryptionDatabaseConstructor;
