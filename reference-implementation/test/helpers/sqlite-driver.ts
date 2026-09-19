// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SQLite driver for tests: the exact constructor production loads.
 *
 * Tests open second connections onto a database `initDb` already owns -- to
 * seed a fixture row, to read back what production wrote, or to contend for
 * the write lock. Every one of those only works if the test connection comes
 * from the SAME native package as the production connection. Importing
 * `better-sqlite3` directly instead loads a second, independently linked
 * SQLite into the process, and then:
 *
 *   - patching `Database.prototype.prepare` intercepts nothing production does;
 *   - a sibling `BEGIN IMMEDIATE` never observes SQLITE_BUSY, because the two
 *     linked copies keep separate inode lock tables (POSIX advisory locks do
 *     not conflict within one process).
 *
 * Both failures are silent -- the assertions just quietly stop meaning what
 * they say. `../sqlite-driver-single-source.test.ts` is what keeps this from
 * drifting back.
 *
 * Typed as stock `better-sqlite3` because the cipher build is API-compatible
 * with it and ships no types of its own.
 */

import type BetterSqlite3 from "better-sqlite3";
import { SqliteDriver } from "../../server/sqlite-driver.ts";

/**
 * `better-sqlite3`-compatible constructor, identical to the one `server/db.ts`
 * uses. Import this in tests instead of a driver package.
 *
 * Exported as a value AND a type namespace so call sites keep the shape the
 * default `better-sqlite3` import had: `new Database(path)` as a value, and
 * `Database.Database` / `Database.Statement` as types.
 */
const Database = SqliteDriver as unknown as typeof BetterSqlite3;

declare namespace Database {
	export type Database = BetterSqlite3.Database;
	export type Options = BetterSqlite3.Options;
	export type RunResult = BetterSqlite3.RunResult;
	export type Statement<
		BindParameters extends unknown[] = unknown[],
		Result = unknown,
	> = BetterSqlite3.Statement<BindParameters, Result>;
	export type Transaction<T extends VariadicFunction = VariadicFunction> =
		BetterSqlite3.Transaction<T>;
}

type VariadicFunction = (...args: never[]) => unknown;

export default Database;
export type { BetterSqlite3 };
export { Database };
