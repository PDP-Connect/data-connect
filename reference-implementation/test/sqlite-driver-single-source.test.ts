// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves exactly one SQLite native driver is loadable per process.
 *
 * `server/sqlite-driver.ts` names the driver package. Nothing else may load a
 * driver package at runtime, because two driver packages in one process are
 * two SEPARATE native addons linking two SEPARATE copies of SQLite, and the
 * resulting failures are silent rather than loud:
 *
 *   - `Database.prototype` is a different object per package, so a test that
 *     patches `prepare()` on one counts ZERO of the calls production makes
 *     through the other. A query-count assertion keeps passing while measuring
 *     nothing.
 *   - SQLite serializes same-file access inside a process through a per-library
 *     inode lock table (POSIX advisory locks do not conflict between two
 *     descriptors the same process holds). Two linked copies keep two tables,
 *     so a sibling `BEGIN IMMEDIATE` opened from the other package never
 *     observes SQLITE_BUSY while production holds the write lock. A locking
 *     assertion keeps passing while proving nothing.
 *   - Only one of the two builds can read an encrypted vault at all.
 *
 * This regressed once already: PR #156 swapped production from `better-sqlite3`
 * to `better-sqlite3-multiple-ciphers` for the encrypted desktop vault, while
 * ~33 test files kept opening the old package. 25 tests changed meaning
 * without anyone writing a wrong assertion.
 *
 * `better-sqlite3` stays a devDependency for its TYPES (the cipher build ships
 * none), so `import type` is allowed everywhere — types are erased and load
 * nothing. Only value loads are gated.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	FORBIDDEN_SQLITE_DRIVER_MODULE,
	SQLITE_DRIVER_MODULE,
	SqliteDriver,
} from "../server/sqlite-driver.ts";

const REFERENCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_DIRS = [
	"server",
	"lib",
	"test",
	"scripts",
	"operations",
] as const;
const SOURCE_EXTENSIONS = [
	".ts",
	".mts",
	".cts",
	".js",
	".mjs",
	".cjs",
] as const;
const SKIPPED_DIR_NAMES = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	"vendor",
]);

/**
 * Files allowed to name a driver package directly.
 *
 * `server/sqlite-driver.ts` is the single source of truth. The two `.mjs`
 * files run standalone under plain `node` with no TypeScript loader, so they
 * cannot import it; they are held to the weaker rule that they name the
 * CORRECT package, asserted separately below.
 */
const DRIVER_NAMING_FILES = new Set([
	join("server", "sqlite-driver.ts"),
	join("test", "fixtures", "summary-source-revision-live-writer.mjs"),
	join("test", "sqlite-encryption-vector-matrix.test.mjs"),
]);

/**
 * Guard tests that carry a driver specifier inside a STRING LITERAL as their
 * own test data (a hostile sample, or a table of specifier forms their
 * detector must catch). Those literals load nothing. They are listed rather
 * than pattern-matched so a real load added to one of these files still has
 * to be justified here.
 */
const DRIVER_NAME_IN_TEST_DATA_FILES = new Set([
	join("test", "connector-config-no-self-declaration.test.ts"),
	join("scripts", "check-test-backends.test.ts"),
]);

function listSourceFiles(): string[] {
	const out: string[] = [];
	function walk(dir: string): void {
		let entries: import("node:fs").Dirent<string>[];
		try {
			entries = readdirSync(dir, { encoding: "utf8", withFileTypes: true });
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code === "ENOENT") {
				return;
			}
			throw err;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIR_NAMES.has(entry.name)) {
					walk(full);
				}
				continue;
			}
			if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
				out.push(full);
			}
		}
	}
	for (const dir of SCANNED_DIRS) {
		walk(join(REFERENCE_ROOT, dir));
	}
	return out;
}

/**
 * Strip comments and `import type` / `export type` statements: both document
 * the rule or reference erased types, and neither loads a native addon.
 */
function stripNonLoadingText(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "")
		.replace(/\bimport\s+type\s[^;]*;/g, "")
		.replace(/\bexport\s+type\s[^;]*;/g, "")
		.replace(/\bimport\(\s*['"][^'"]*['"]\s*\)\s*\.\s*\w+/g, "");
}

/** Every way a value-position load of `specifier` can be written. */
function valueLoadPatterns(specifier: string): RegExp[] {
	const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [
		// import x from "<spec>" / import { x } from "<spec>" / export … from "<spec>"
		new RegExp(`\\bfrom\\s*['"]${escaped}['"]`),
		// import "<spec>" (side-effect)
		new RegExp(`\\bimport\\s+['"]${escaped}['"]`),
		// await import("<spec>")
		new RegExp(`\\bimport\\s*\\(\\s*['"]${escaped}['"]`),
		// require("<spec>") / createRequire(...)("<spec>")
		new RegExp(`\\brequire\\s*\\(\\s*['"]${escaped}['"]`),
		new RegExp(`createRequire\\([^)]*\\)\\s*\\(\\s*['"]${escaped}['"]`),
	];
}

test("only server/sqlite-driver.ts loads a SQLite driver package", () => {
	const offenders: string[] = [];
	for (const file of listSourceFiles()) {
		const rel = relative(REFERENCE_ROOT, file);
		if (
			DRIVER_NAMING_FILES.has(rel) ||
			DRIVER_NAME_IN_TEST_DATA_FILES.has(rel)
		) {
			continue;
		}
		const source = stripNonLoadingText(readFileSync(file, "utf8"));
		for (const specifier of [
			SQLITE_DRIVER_MODULE,
			FORBIDDEN_SQLITE_DRIVER_MODULE,
		]) {
			if (
				valueLoadPatterns(specifier).some((pattern) => pattern.test(source))
			) {
				offenders.push(`${rel} loads "${specifier}"`);
			}
		}
	}
	assert.deepEqual(
		offenders,
		[],
		"these files must import { SqliteDriver } from server/sqlite-driver.ts " +
			"(or, in tests, Database from test/helpers/sqlite-driver.ts) instead of naming a " +
			`driver package:\n  ${offenders.join("\n  ")}`,
	);
});

for (const rel of [
	join("test", "fixtures", "summary-source-revision-live-writer.mjs"),
	join("test", "sqlite-encryption-vector-matrix.test.mjs"),
]) {
	test(`${rel} pins the same driver package production uses`, () => {
		const source = stripNonLoadingText(
			readFileSync(join(REFERENCE_ROOT, rel), "utf8"),
		);
		assert.ok(
			valueLoadPatterns(SQLITE_DRIVER_MODULE).some((pattern) =>
				pattern.test(source),
			),
			`${rel} runs without a TypeScript loader, so it names the driver directly — it must name "${SQLITE_DRIVER_MODULE}"`,
		);
		assert.ok(
			!valueLoadPatterns(FORBIDDEN_SQLITE_DRIVER_MODULE).some((pattern) =>
				pattern.test(source),
			),
			`${rel} must not load "${FORBIDDEN_SQLITE_DRIVER_MODULE}"`,
		);
	});
}

test("the test helper hands back the exact constructor production uses", async () => {
	const { default: TestDatabase, Database: namedExport } = await import(
		"./helpers/sqlite-driver.ts"
	);
	assert.equal(
		TestDatabase as unknown,
		SqliteDriver as unknown,
		"test/helpers/sqlite-driver.ts must re-export the production driver, not load its own",
	);
	assert.equal(namedExport as unknown, SqliteDriver as unknown);
});

test("the linked driver is a cipher build that can key a database", () => {
	// Distinguishes the two packages by capability rather than by name: stock
	// better-sqlite3 exposes no `key`/`rekey`. If this fails, production is
	// linked against the non-cipher build and the encrypted vault cannot open.
	const database = new SqliteDriver(":memory:", { timeout: 0 });
	try {
		assert.equal(
			typeof database.key,
			"function",
			"the linked driver must expose key()",
		);
		assert.equal(
			typeof database.rekey,
			"function",
			"the linked driver must expose rekey()",
		);
	} finally {
		database.close();
	}
});
