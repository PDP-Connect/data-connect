// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
	selectAffectedTests,
	validateFilesFrom,
} from "./run-tests-affected.ts";

const scratchRoot = join(homedir(), ".tmp", "testeng", "dcri");
const roots: string[] = [];
const staticImport = (specifier: string) =>
	["import ", JSON.stringify(specifier), ";"].join("");
const dynamicImport = (specifier: string) =>
	["const load = () => import(", JSON.stringify(specifier), ");"].join("");

async function tree(files: Record<string, string>): Promise<string> {
	await mkdir(scratchRoot, { recursive: true });
	const root = await mkdtemp(join(scratchRoot, "fast-test-"));
	roots.push(root);
	for (const [path, source] of Object.entries(files)) {
		const destination = join(root, path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, source);
	}
	return root;
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

test("selects a directly changed test", async () => {
	const root = await tree({
		"test/direct.test.ts": "test('x', () => {});",
		"test/other.test.ts": "test('y', () => {});",
	});
	const result = await selectAffectedTests(
		root,
		["test/direct.test.ts", "test/other.test.ts"],
		{
			addedOrModified: ["reference-implementation/test/direct.test.ts"],
			deleted: [],
		},
	);
	assert.deepEqual(result.files, ["test/direct.test.ts"]);
});

test("selects a test for a transitive import two hops away", async () => {
	const root = await tree({
		"test/a.test.ts": staticImport("../server/one.ts"),
		"server/one.ts": staticImport("./two.ts"),
		"server/two.ts": "export const value = 1;",
	});
	const result = await selectAffectedTests(root, ["test/a.test.ts"], {
		addedOrModified: ["reference-implementation/server/two.ts"],
		deleted: [],
	});
	assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("resolves a .js import to its .ts source", async () => {
	const root = await tree({
		"test/a.test.ts": staticImport("../server/impl.js"),
		"server/impl.ts": "export const value = 1;",
	});
	const result = await selectAffectedTests(root, ["test/a.test.ts"], {
		addedOrModified: ["reference-implementation/server/impl.ts"],
		deleted: [],
	});
	assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("follows a literal dynamic import", async () => {
	const root = await tree({
		"test/a.test.ts": dynamicImport("../server/later.ts"),
		"server/later.ts": "export const value = 1;",
	});
	const result = await selectAffectedTests(root, ["test/a.test.ts"], {
		addedOrModified: ["reference-implementation/server/later.ts"],
		deleted: [],
	});
	assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("follows a module path in new URL relative to import.meta.url", async () => {
	const root = await tree({
		"test/a.test.ts":
			'const path = new URL("../server/config.json", import.meta.url);',
		"server/config.json": '{"enabled":true}',
	});
	const result = await selectAffectedTests(root, ["test/a.test.ts"], {
		addedOrModified: ["reference-implementation/server/config.json"],
		deleted: [],
	});
	assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("connects a SQL asset by a relative string literal", async () => {
	const root = await tree({
		"test/a.test.ts": staticImport("../server/query.ts"),
		"server/query.ts": 'readFileSync("../sql/schema.sql");',
		"sql/schema.sql": "select 1;",
	});
	const result = await selectAffectedTests(root, ["test/a.test.ts"], {
		addedOrModified: ["reference-implementation/sql/schema.sql"],
		deleted: [],
	});
	assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("connects a JSON fixture by its basename string literal", async () => {
	const root = await tree({
		"test/a.test.ts": staticImport("../server/query.ts"),
		"server/query.ts": 'readFileSync("fixture.json");',
		"fixtures/fixture.json": '{"value":1}',
	});
	const result = await selectAffectedTests(root, ["test/a.test.ts"], {
		addedOrModified: ["reference-implementation/fixtures/fixture.json"],
		deleted: [],
	});
	assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("falls back for an unreferenced asset", async () => {
	const root = await tree({
		"test/a.test.ts": "test('x', () => {});",
		"assets/readme.txt": "x",
	});
	const result = await selectAffectedTests(root, ["test/a.test.ts"], {
		addedOrModified: ["reference-implementation/assets/readme.txt"],
		deleted: [],
	});
	assert.equal(result.fallback, true);
	assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("falls back for package.json", async () => {
	const root = await tree({ "test/a.test.ts": "test('x', () => {});" });
	const result = await selectAffectedTests(root, ["test/a.test.ts"], {
		addedOrModified: ["reference-implementation/package.json"],
		deleted: [],
	});
	assert.equal(result.fallback, true);
});

test("falls back for a deleted module", async () => {
	const root = await tree({ "test/a.test.ts": "test('x', () => {});" });
	const result = await selectAffectedTests(root, ["test/a.test.ts"], {
		addedOrModified: [],
		deleted: ["reference-implementation/server/gone.ts"],
	});
	assert.equal(result.fallback, true);
	assert.match(result.reason, /deleted module/);
});

test("selects nothing for an empty change set", async () => {
	const root = await tree({ "test/a.test.ts": "test('x', () => {});" });
	const result = await selectAffectedTests(root, ["test/a.test.ts"], {
		addedOrModified: [],
		deleted: [],
	});
	assert.deepEqual(result.files, []);
	assert.equal(result.fallback, false);
});

test("rejects a files-from entry outside standalone discovery", async () => {
	await assert.rejects(
		validateFilesFrom(["server/not-a-test.ts"], ["test/a.test.ts"]),
		/outside test discovery/,
	);
});

test("skips full-suite named mapping finalization for files-from runs", async () => {
	const runner = await readFile(
		new URL("./run-tests.ts", import.meta.url),
		"utf8",
	);
	assert.match(
		runner,
		/if \(filesFromIndex === -1 && !failed && results\.length === testFiles\.length\)/,
	);
});
