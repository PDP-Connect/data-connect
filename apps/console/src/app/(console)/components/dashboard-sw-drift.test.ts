// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// The browser loads the committed .js. It is the plain transpile of the .ts
// (target ES2022, no module). A text change in the .ts that is not rebuilt
// would ship old lock-screen words, so the two must agree exactly.
const read = (name: string) => readFileSync(new URL(`../../../../public/${name}`, import.meta.url), "utf8");

test("the served service worker is the transpile of its source", () => {
	const built = ts.transpileModule(read("pdpp-dashboard-sw.ts"), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
	}).outputText;
	assert.equal(read("pdpp-dashboard-sw.js"), built, "rebuild public/pdpp-dashboard-sw.js from the .ts");
});

test("every text a person can read in the source is in the served file", () => {
	const served = read("pdpp-dashboard-sw.js");
	for (const [, text] of read("pdpp-dashboard-sw.ts").matchAll(/"((?:DataConnect|Open DataConnect|This is a test)[^"]*)"/g)) {
		assert.ok(served.includes(text ?? ""), text);
	}
	assert.ok(!served.includes("PDPP action needed"));
});
