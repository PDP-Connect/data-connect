// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for the r136 readability fixes (selected text, facet row layout).
 *
 * Contrast is computed from the real token values in primitive.css, not from a
 * rendered page: the console test stack has no CSS engine. The layout rules are
 * asserted against the CSS source.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const vendor = new URL(
	"../../../../../../reference-implementation/vendor/",
	import.meta.url,
);
const read = (rel: string) => readFileSync(new URL(rel, vendor), "utf8");

const base = read("brand/styles/base.css");
const tokens = read("brand/styles/tokens/primitive.css");
const components = read("brand-react/src/components.css");
const canvas = readFileSync(
	new URL("./explore-canvas.tsx", import.meta.url),
	"utf8",
);

function rule(css: string, selector: string): string {
	const start = css.indexOf(`${selector} {`);
	assert.notEqual(start, -1, `missing rule ${selector}`);
	return css.slice(start, css.indexOf("}", start));
}

function tokenBlock(selector: string): string {
	const start = tokens.indexOf(`${selector} {`);
	assert.notEqual(start, -1, `missing token block ${selector}`);
	return tokens.slice(start, tokens.indexOf("\n}", start));
}

function oklchToLinearRgb(
	l: number,
	c: number,
	hDeg: number,
): [number, number, number] {
	const h = (hDeg * Math.PI) / 180;
	const a = c * Math.cos(h);
	const b = c * Math.sin(h);
	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const clamp = (v: number) => Math.min(1, Math.max(0, v));
	return [
		clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
		clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
		clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
	];
}

function luminance(block: string, name: string): number {
	const m = new RegExp(
		`--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`,
	).exec(block);
	assert.ok(m, `token --${name} is not a plain oklch() value`);
	const [r, g, b] = oklchToLinearRgb(Number(m[1]), Number(m[2]), Number(m[3]));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(block: string, fg: string, bg: string): number {
	const a = luminance(block, fg);
	const b = luminance(block, bg);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("::selection uses the accent / accent-foreground pair", () => {
	const selection = rule(base, "::selection");
	assert.match(selection, /bg-accent\s+text-accent-foreground/);
	assert.doesNotMatch(selection, /bg-accent\/\d+/);
	assert.doesNotMatch(selection, /text-background/);
});

test("accent / accent-foreground stay readable in light and dark", () => {
	for (const selector of [":root", '[data-theme="dark"]']) {
		const ratio = contrast(tokenBlock(selector), "accent-foreground", "accent");
		assert.ok(
			ratio >= 7,
			`${selector} selection contrast ${ratio.toFixed(2)} < 7`,
		);
	}
});

test("facet rows get an 8px gap and an ellipsized label", () => {
	const name = rule(components, ".rr-x-facet__name");
	assert.match(name, /display:\s*flex/);
	assert.match(name, /gap:\s*8px/);
	assert.match(name, /min-width:\s*0/);

	const label = rule(components, ".rr-x-facet__label");
	assert.match(label, /min-width:\s*0/);
	assert.match(label, /overflow:\s*hidden/);
	assert.match(label, /text-overflow:\s*ellipsis/);

	assert.match(canvas, /<span className="rr-x-facet__label">\{label\}<\/span>/);
});

test("the exclude control is not faded", () => {
	const control = rule(components, ".rr-x-facet-not");
	assert.doesNotMatch(control, /opacity/);
	assert.doesNotMatch(rule(components, ".rr-x-facet-not.is-on"), /opacity/);
});
