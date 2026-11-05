// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Readability of selected text and of the Explore facet rail, judged on the
 * effective style under the CSS the console ships (see
 * `compiled-console-css.harness.ts`), not on how the CSS is written. A later
 * rule that brings a bug back fails these tests; a harmless rewrite does not.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	mountUnderShippedCss,
	type ProbeState,
	type StyleProbe,
} from "./compiled-console-css.harness.ts";

// The canvas module's import graph reaches `server-only`, which throws
// outside a server component.
mock.module("server-only", { namedExports: {} });
const canvasModule = import("./explore-canvas.tsx");

const LONG_LABEL = `connection-${"very-long-name-".repeat(12)}example.com`;

async function facetRowHtml(excluded: boolean): Promise<string> {
	const { FacetRow } = await canvasModule;
	return renderToStaticMarkup(
		createElement(FacetRow, {
			count: 12,
			excluded,
			label: LONG_LABEL,
			on: false,
			onToggle() {},
			onToggleExclude() {},
		}),
	);
}

// ── selection contrast, from the final compiled colors ────────────

function toLinearRgb(
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

const VAR_REFERENCE = /^var\((--[\w-]+)\)$/;
const PLAIN_OKLCH = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/;

/** Resolves a computed color to an opaque oklch triple, or fails loudly. */
function opaqueColor(
	declaration: CSSStyleDeclaration,
	property: string,
): [number, number, number] {
	let value = declaration.getPropertyValue(property).trim();
	for (let hops = 0; hops < 5; hops += 1) {
		const reference = VAR_REFERENCE.exec(value);
		if (!reference?.[1]) {
			break;
		}
		value = declaration.getPropertyValue(reference[1]).trim();
	}
	const match = PLAIN_OKLCH.exec(value);
	assert.ok(
		match,
		`selection ${property} is "${value}", not a plain opaque oklch() color`,
	);
	return toLinearRgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

function luminance([r, g, b]: [number, number, number]): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function selectionContrast(probe: StyleProbe): number {
	const selection = probe.selectionStyle("p");
	const text = luminance(opaqueColor(selection, "color"));
	const background = luminance(opaqueColor(selection, "background-color"));
	return (
		(Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05)
	);
}

for (const theme of ["light", "dark"] as const) {
	test(`selected text meets 7:1 contrast in the ${theme} theme`, async () => {
		const probe = await mountUnderShippedCss("<p>selected</p>", theme);
		const ratio = selectionContrast(probe);
		assert.ok(
			ratio >= 7,
			`${theme} selection contrast ${ratio.toFixed(2)} < 7`,
		);
	});
}

test("a translucent selection background is rejected, not measured", async () => {
	const probe = await mountUnderShippedCss(
		"<p>selected</p>",
		"light",
		".__selection__ { background-color: color-mix(in oklab, var(--accent) 70%, transparent); }",
	);
	assert.throws(() => selectionContrast(probe), /not a plain opaque oklch/);
});

// ── facet rows ────────────────────────────────────────────────────

const LABEL = ".rr-x-facet__label";
const NAME = ".rr-x-facet__name";
const EXCLUDE = ".rr-x-facet-not";
const EXCLUDE_STATES: readonly (readonly ProbeState[])[] = [
	[],
	["hover"],
	["focus"],
	["focus-visible"],
	["active"],
	["hover", "focus-visible", "active"],
];

/** What keeps a long label on one line inside the rail, as reasons it does not. */
function facetLabelProblems(probe: StyleProbe): string[] {
	const name = probe.style(NAME);
	const label = probe.style(LABEL);
	const problems: string[] = [];
	// jsdom does not inherit white-space; the label inherits it from the name.
	const whiteSpace =
		label.whiteSpace === "normal" ? name.whiteSpace : label.whiteSpace;
	if (whiteSpace !== "nowrap") {
		problems.push(`label wraps (white-space: ${whiteSpace})`);
	}
	if (label.overflow !== "hidden") {
		problems.push(`label overflow is ${label.overflow}, not hidden`);
	}
	if (label.textOverflow !== "ellipsis") {
		problems.push(`label text-overflow is ${label.textOverflow}, not ellipsis`);
	}
	if (label.minWidth !== "0px") {
		problems.push(
			`label min-width is ${label.minWidth}, so it cannot shrink below its text`,
		);
	}
	if (
		name.display !== "flex" ||
		name.minWidth !== "0px" ||
		name.overflow !== "hidden"
	) {
		problems.push(
			`name does not contain the label (display ${name.display}, min-width ${name.minWidth}, overflow ${name.overflow})`,
		);
	}
	return problems;
}

/** Every state of the exclude control, with the states where it is faded. */
async function fadedExcludeStates(
	html: (excluded: boolean) => Promise<string>,
	extraCss = "",
): Promise<string[]> {
	{
		const faded: string[] = [];
		for (const excluded of [false, true]) {
			const probe = await mountUnderShippedCss(
				await html(excluded),
				"light",
				extraCss,
			);
			for (const states of EXCLUDE_STATES) {
				const opacity = probe.style(EXCLUDE, states).opacity;
				if (opacity !== "1") {
					faded.push(
						`${excluded ? "excluded" : "not excluded"} [${states.join("+") || "rest"}]: opacity ${opacity}`,
					);
				}
			}
		}
		return faded;
	}
}

test("a long facet label is contained and ellipsized", async () => {
	const probe = await mountUnderShippedCss(await facetRowHtml(false), "light");
	assert.deepEqual(facetLabelProblems(probe), []);
});

test("the exclude control is never faded, in any state", async () => {
	assert.deepEqual(await fadedExcludeStates(facetRowHtml), []);
});

// ── a later override must bring the bug back as a failure ─────────

test("a later rule that stops the label truncating is detected", async () => {
	const probe = await mountUnderShippedCss(
		await facetRowHtml(false),
		"light",
		`${LABEL} { overflow: visible; text-overflow: clip; }`,
	);
	assert.deepEqual(facetLabelProblems(probe), [
		"label overflow is visible, not hidden",
		"label text-overflow is clip, not ellipsis",
	]);
});

test("a later rule that fades the exclude control again is detected", async () => {
	const faded = await fadedExcludeStates(
		facetRowHtml,
		`${EXCLUDE} { opacity: 0.45; }`,
	);
	assert.equal(faded.length, EXCLUDE_STATES.length * 2);
	assert.match(faded[0] ?? "", /opacity 0\.45/);
});

test("a later rule in the same layer that fades the exclude control again is detected", async () => {
	const faded = await fadedExcludeStates(
		facetRowHtml,
		`@layer components { ${EXCLUDE} { opacity: 0.45; } }`,
	);
	assert.equal(faded.length, EXCLUDE_STATES.length * 2);
});

test("a hover-only fade of the exclude control is detected", async () => {
	const faded = await fadedExcludeStates(
		facetRowHtml,
		".rr-x-facet-row:hover .rr-x-facet-not { opacity: 0.8; }",
	);
	assert.ok(faded.some((entry) => entry.includes("[hover]")));
	assert.ok(!faded.some((entry) => entry.includes("[rest]")));
});
