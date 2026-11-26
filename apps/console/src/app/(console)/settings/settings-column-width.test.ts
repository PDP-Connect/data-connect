// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// On a 390 px phone the main is 380 px. A grid with no column template gets one
// automatic column that grows to its widest child's minimum (389 px), so the
// header and sections ran past the right edge. The column must be a shrinkable track.
const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const column = /<div className="([^"]*max-w-5xl[^"]*)">/.exec(source)?.[1] ?? "";

test("the Settings column is a shrinkable single track", () => {
	const classes = column.split(/\s+/);
	assert.ok(classes.includes("grid"), column);
	assert.ok(classes.includes("grid-cols-1"), "a grid without grid-cols-1 sizes its column to its widest child");
});

test("no fixed or minimum width on the Settings column", () => {
	const widths = column.split(/\s+/).filter((name) => /^(min-w|w)-/.test(name) && name !== "min-w-0" && name !== "w-full");
	assert.deepEqual(widths, []);
});

// The shared button is `whitespace-nowrap shrink-0`. Inside the pairing row's own grid, a
// long label then set that grid's column to the label's full width (389 px at 390).
test("the pairing toggle can wrap its long label on a phone", () => {
	const pairing = readFileSync(new URL("./desktop-pairing-setting.tsx", import.meta.url), "utf8");
	const toggle = /<Button aria-expanded=\{expanded\} className="([^"]*)"/.exec(pairing)?.[1] ?? "";
	const classes = toggle.split(/\s+/);
	for (const name of ["whitespace-normal", "min-w-0", "h-auto"]) assert.ok(classes.includes(name), `${name} missing from: ${toggle}`);
});
