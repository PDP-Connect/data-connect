// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageRoot = dirname(
	fileURLToPath(import.meta.resolve("@tnunamak/gozar/package.json")),
);
async function identifiers() {
	const ids = new Set();
	const registry = JSON.parse(
		await readFile(join(packageRoot, "adapters/manifest.json"), "utf8"),
	);
	for (const provider of registry.providers) {
		ids.add(provider.id);
		const definition = JSON.parse(
			await readFile(
				join(packageRoot, "adapters", provider.definition),
				"utf8",
			),
		);
		for (const fact of (definition.adapter ?? definition).facts ?? [])
			ids.add(fact.id);
	}
	for (const name of [
		"unknown-provider.json",
		"non-http-provider.json",
		"install-provider.json",
	]) {
		const fixture = JSON.parse(
			await readFile(
				join(root, "reference-implementation/test/fixtures/reachability", name),
				"utf8",
			),
		);
		ids.add(fixture.id);
		if (fixture.secondId) ids.add(fixture.secondId);
		for (const fact of [...(fixture.facts ?? []), fixture.addedFact].filter(
			Boolean,
		))
			ids.add(fact.id);
	}
	return ids;
}
function inspect(path, source, ids) {
	assert.ok(
		!/@tnunamak\/gozar\/(?:packages|runtime|adapters)\//.test(source),
		`Private package path in ${path}`,
	);
	for (const match of source.matchAll(/(["'`])([^"'`\r\n]+)\1/g)) {
		const value = match[2];
		if (!ids.has(value)) continue;
		const context = source.slice(
			Math.max(0, match.index - 100),
			match.index + match[0].length + 100,
		);
		// The explicit host-policy exception: typed reach/mode comparisons. This
		// does not exempt providerId, fact IDs, whole files or arbitrary strings.
		if (
			value === "lan" &&
			/\b(?:reach|mode)\b/.test(context) &&
			!/(providerId|fact\.id)\s*===/.test(context)
		)
			continue;
		assert.fail(`Opaque registry identifier ${value} embedded in ${path}`);
	}
}
async function bundleFiles(dir) {
	const files = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await bundleFiles(path)));
		else if (entry.name.endsWith(".js")) files.push(path);
	}
	return files;
}
test("product source and the browser bundle remain independent of registry identifiers", async () => {
	const ids = await identifiers();
	const files = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard"],
		{ cwd: root, encoding: "utf8" },
	)
		.trim()
		.split("\n");
	const deleted = new Set(execFileSync("git", ["ls-files", "--deleted"], { cwd: root, encoding: "utf8" }).trim().split("\n"));
	for (const path of files) {
		if (
			deleted.has(path) ||
			!/\.(?:ts|tsx|js|mjs)$/.test(path) ||
			path.includes("/fixtures/") ||
			path === "reference-implementation/server/legacy-remote-access-import.ts"
		)
			continue;
		inspect(path, await readFile(join(root, path), "utf8"), ids);
	}
	const bundles = await bundleFiles(join(root, "apps/console/.next/static"));
	assert.ok(
		bundles.length,
		"Built browser bundle is required; this check must not silently skip",
	);
	for (const path of bundles) inspect(path, await readFile(path, "utf8"), ids);
});
