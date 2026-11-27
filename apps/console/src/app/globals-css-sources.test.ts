// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindPostcss from "@tailwindcss/postcss";
import postcss from "postcss";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, "globals.css");
const source = readFileSync(cssPath, "utf8");

function sourceDirectories(): string[] {
	return [...source.matchAll(/^@source\s+"([^"]+)"/gm)].map((match) => {
		const glob = match[1] ?? "";
		// Keep the static prefix before the first glob segment.
		const staticPrefix = glob.split("/").filter((part) => !/[*{]/.test(part));
		return resolve(here, staticPrefix.join("/"));
	});
}

test("every @source directory in globals.css exists", () => {
	const dirs = sourceDirectories();
	assert.ok(
		dirs.length >= 2,
		"expected the operator-ui and brand-react @source entries",
	);
	for (const dir of dirs) {
		assert.ok(existsSync(dir), `@source directory does not exist: ${dir}`);
	}
});

test("compiled CSS contains utilities used only by the vendored operator-ui and brand-react packages", async () => {
	const result = await postcss([tailwindPostcss()]).process(source, {
		from: cssPath,
	});
	const css = result.css;
	// Command palette position and backdrop utilities (operator-ui command-palette.tsx, ui/dialog.tsx).
	for (const selector of [
		".z-50",
		".top-24",
		".left-1\\/2",
		".-translate-x-1\\/2",
		".backdrop-blur-sm",
	]) {
		assert.ok(css.includes(selector), `compiled CSS is missing ${selector}`);
	}
	// A sample of the 364 utilities the stale paths purged.
	for (const selector of [
		".-ml-px",
		".-mx-6",
		".-translate-y-1\\/2",
		".\\@container\\/card-header",
	]) {
		assert.ok(css.includes(selector), `compiled CSS is missing ${selector}`);
	}
	assert.ok(
		css.includes("bg-black\\/40"),
		"compiled CSS is missing bg-black/40",
	);
	assert.ok(
		css.includes("w-\\[calc\\(100\\%-2rem\\)\\]"),
		"compiled CSS is missing w-[calc(100%-2rem)]",
	);
});
