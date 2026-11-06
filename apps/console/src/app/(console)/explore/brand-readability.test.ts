// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Readability of selected text and of the Explore facet rail, judged in a real
 * browser under the CSS the console ships (see `compiled-console-css.harness.ts`).
 * The browser resolves the cascade, so a later rule that brings a bug back
 * fails these tests and a harmless rewrite of the CSS does not.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, mock, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	launchBrowser,
	openShippedPage,
	type PageOptions,
	type Rgba,
	resolveColor,
} from "./compiled-console-css.harness.ts";

// The canvas module's import graph reaches `server-only`, which throws
// outside a server component.
mock.module("server-only", { namedExports: {} });
// `connector-mark.tsx` has no React import: Next compiles it with the automatic
// JSX runtime, the test transform does not.
Object.assign(globalThis, { React });
const canvasModule = import("./explore-canvas.tsx");
const connectorMarkModule = import("../components/connector-mark.tsx");

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const LONG_LABEL = `connection-${"very-long-name-".repeat(12)}example.com`;
/** The Explore facet rail is 230px wide. */
const RAIL_WIDTH = 230;

// Unset when the launch failed: the `after` hook must not throw its own
// TypeError over the launch error, which says what to install.
let browser: Browser | undefined;
before(async () => {
	browser = await launchBrowser();
});
after(async () => {
	await browser?.close();
});

async function withPage<T>(
	html: string,
	options: PageOptions,
	run: (page: Page) => Promise<T>,
): Promise<T> {
	if (!browser) {
		throw new Error("the browser did not launch");
	}
	const page = await openShippedPage(browser, html, options);
	try {
		return await run(page);
	} finally {
		await page.close();
	}
}

async function facetRowHtml(excluded: boolean): Promise<string> {
	const { FacetRow } = await canvasModule;
	const { ConnectorMark } = await connectorMarkModule;
	return renderToStaticMarkup(
		createElement(FacetRow, {
			count: 12,
			excluded,
			label: LONG_LABEL,
			// The mark production passes (explore-canvas.tsx), not a stand-in.
			leading: createElement(ConnectorMark, {
				className: "size-5 shrink-0",
				icon: null,
				name: "Example",
			}),
			on: false,
			onToggle() {},
			onToggleExclude() {},
		}),
	);
}

// ── selected text ─────────────────────────────────────────────────

function relativeLuminance({ r, g, b }: Rgba): number {
	const channel = (value: number) => {
		const unit = value / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
	const [lighter = 0, darker = 0] = [
		relativeLuminance(a),
		relativeLuminance(b),
	].sort((x, y) => y - x);
	return (lighter + 0.05) / (darker + 0.05);
}

/** `top` as it looks over an opaque `under`. */
function composite(top: Rgba, under: Rgba): Rgba {
	return {
		a: 1,
		b: top.a * top.b + (1 - top.a) * under.b,
		g: top.a * top.g + (1 - top.a) * under.g,
		r: top.a * top.r + (1 - top.a) * under.r,
	};
}

// Selected text must beat WCAG AAA (7:1), not just AA (4.5:1): it is the text
// the user is reading and acting on, and the shipped pair measures 13-15:1, so
// the bar costs no design room.
const SELECTION_MIN_CONTRAST = 7;
// Facet names are small text (12.5px): WCAG AA for normal text.
const FACET_TEXT_MIN_CONTRAST = 4.5;

/** Why the text the user selects in a paragraph is hard to read, if it is. */
async function selectionProblems(options: PageOptions): Promise<string[]> {
	return await withPage("<p>selected</p>", options, async (page) => {
		const { background, color, selected } = await page.evaluate(() => {
			const paragraph = document.querySelector("p");
			if (!paragraph) {
				throw new Error("no paragraph");
			}
			getSelection()?.selectAllChildren(paragraph);
			const style = getComputedStyle(paragraph, "::selection");
			return {
				background: style.backgroundColor,
				color: style.color,
				selected: String(getSelection()),
			};
		});
		assert.equal(selected, "selected", "the text is really selected");
		const ink = await resolveColor(page, color);
		const fill = await resolveColor(page, background);
		// Text that is not fully opaque shows the selection fill through it.
		const text = composite(ink, fill);
		const problems: string[] = [];
		if (fill.a < 1) {
			problems.push(
				`selection background is translucent (alpha ${fill.a.toFixed(2)})`,
			);
		}
		const ratio = contrastRatio(text, fill);
		if (ratio < SELECTION_MIN_CONTRAST) {
			problems.push(`selection contrast ${ratio.toFixed(2)}:1 is below 7:1`);
		}
		return problems;
	});
}

for (const theme of THEMES) {
	test(`selected text is opaque and meets 7:1 contrast in the ${theme} theme`, async () => {
		assert.deepEqual(await selectionProblems({ theme }), []);
	});
}

test("a later element-qualified selection rule that hides selected text is detected", async () => {
	const problems = await selectionProblems({
		extraCss:
			"p::selection { color: oklch(0 0 0); background-color: oklch(0 0 0); }",
	});
	assert.match(problems.join("; "), /contrast 1\.00:1 is below 7:1/);
});

test("a transparent selection foreground is detected as invisible text", async () => {
	const problems = await selectionProblems({
		extraCss:
			"p::selection { color: rgba(0, 0, 0, 0); background-color: #fff; }",
	});
	assert.match(problems.join("; "), /contrast 1\.00:1 is below 7:1/);
});

test("a translucent selection background is detected", async () => {
	const problems = await selectionProblems({
		extraCss:
			"::selection { background-color: color-mix(in oklab, var(--accent) 70%, transparent); }",
	});
	assert.match(problems.join("; "), /translucent/);
});

// ── facet rows ────────────────────────────────────────────────────

type ControlState = "rest" | "hover" | "focus" | "focus-visible" | "active";

/** The pseudo-classes that must hold for each state, so a state is isolated. */
const EXPECTED_PSEUDO: Record<
	ControlState,
	Partial<Record<string, boolean>>
> = {
	active: { ":active": true, ":hover": true },
	focus: { ":focus": true, ":focus-visible": false, ":hover": false },
	"focus-visible": { ":focus": true, ":focus-visible": true, ":hover": false },
	hover: { ":active": false, ":focus": false, ":hover": true },
	rest: { ":active": false, ":focus": false, ":hover": false },
};
const PSEUDO_CLASSES = [":hover", ":focus", ":focus-visible", ":active"];

/** The exclude control's opacity in one real, isolated interaction state. */
async function excludeOpacity(
	excluded: boolean,
	state: ControlState,
	options: PageOptions,
): Promise<string> {
	return await withPage(
		await facetRowHtml(excluded),
		{ ...options, width: RAIL_WIDTH },
		async (page) => {
			const control = page.locator(".rr-x-facet-not");
			if (state === "hover") {
				await control.hover();
			} else if (state === "focus") {
				await control.click();
				await page.mouse.move(0, 0);
			} else if (state === "focus-visible") {
				// Tab until the control has focus, so a tabbable element added
				// ahead of it does not change which control this state tests.
				for (let presses = 0; presses < 10; presses++) {
					await page.keyboard.press("Tab");
					if (
						await control.evaluate(
							(element) => element === document.activeElement,
						)
					) {
						break;
					}
				}
			} else if (state === "active") {
				await control.hover();
				await page.mouse.down();
			}
			const { opacity, pseudo } = await control.evaluate(
				(element, classes) => ({
					opacity: getComputedStyle(element).opacity,
					pseudo: Object.fromEntries(
						classes.map((name) => [name, element.matches(name)]),
					),
				}),
				PSEUDO_CLASSES,
			);
			for (const [name, expected] of Object.entries(EXPECTED_PSEUDO[state])) {
				assert.equal(
					pseudo[name],
					expected,
					`${state}: ${name} should be ${expected}`,
				);
			}
			return opacity;
		},
	);
}

const CONTROL_STATES: readonly ControlState[] = [
	"rest",
	"hover",
	"focus",
	"focus-visible",
	"active",
];

/** Every state of the exclude control in which it is faded. */
async function fadedExcludeStates(
	options: PageOptions = {},
): Promise<string[]> {
	const faded: string[] = [];
	for (const excluded of [false, true]) {
		for (const state of CONTROL_STATES) {
			const opacity = await excludeOpacity(excluded, state, options);
			if (opacity !== "1") {
				faded.push(
					`${excluded ? "excluded" : "not excluded"} [${state}]: opacity ${opacity}`,
				);
			}
		}
	}
	return faded;
}

/** Why a long label does not stay on one line inside the rail, if it does not. */
async function facetLabelProblems(
	options: PageOptions = {},
): Promise<string[]> {
	return await withPage(
		await facetRowHtml(false),
		{ ...options, width: RAIL_WIDTH },
		async (page) => {
			// No nested helper functions in here: the transpiler would reference a
			// helper that does not exist in the page.
			const box = await page.evaluate(() => {
				const row = document.querySelector(".rr-x-facet-row");
				const exclude = document.querySelector(".rr-x-facet-not");
				// The label is whichever element directly holds the text.
				const leading = document.querySelector(
					".pdpp-monogram, .pdpp-connector-icon",
				);
				let text: Node | null = null;
				for (const element of document.querySelectorAll("#mount *")) {
					for (const child of element.childNodes) {
						if (
							child.nodeType === 3 &&
							child.textContent?.includes("example.com")
						) {
							text = child;
						}
					}
				}
				const label = text?.parentElement;
				if (!(row && label && leading && text && exclude)) {
					throw new Error("the facet row did not render");
				}
				const textRange = document.createRange();
				textRange.selectNodeContents(text);
				const rowBox = row.getBoundingClientRect();
				const excludeBox = exclude.getBoundingClientRect();
				const style = getComputedStyle(label);
				return {
					// text-overflow paints an ellipsis only on a clipping block container.
					ellipsis:
						style.textOverflow === "ellipsis" &&
						style.overflowX !== "visible" &&
						(style.display === "block" ||
							style.display === "flow-root" ||
							style.display === "inline-block"),
					excludeLeft: excludeBox.left,
					excludeRight: excludeBox.right,
					leadingRight: leading.getBoundingClientRect().right,
					labelHeight: label.getBoundingClientRect().height,
					lineHeight:
						Number.parseFloat(style.lineHeight) ||
						Number.parseFloat(style.fontSize) * 1.5,
					rowLeft: rowBox.left,
					rowRight: rowBox.right,
					labelRight: label.getBoundingClientRect().right,
					textLeft: textRange.getBoundingClientRect().left,
					truncated: label.scrollWidth > label.clientWidth,
				};
			});
			const problems: string[] = [];
			if (box.labelHeight > box.lineHeight * 1.2) {
				problems.push(
					`label wraps onto ${Math.round(box.labelHeight / box.lineHeight)} lines`,
				);
			}
			if (box.labelRight > box.rowRight) {
				problems.push("the label extends past the row");
			}
			if (box.excludeRight > box.rowRight || box.excludeLeft < box.rowLeft) {
				problems.push("the exclude control is pushed outside the row");
			}
			if (box.textLeft - box.leadingRight < 8) {
				problems.push(
					`the label starts ${Math.round(box.textLeft - box.leadingRight)}px after the icon, less than 8px`,
				);
			}
			if (!box.truncated) {
				problems.push("the long label is not truncated");
			}
			if (!box.ellipsis) {
				problems.push("the truncated label has no ellipsis");
			}
			return problems;
		},
	);
}

for (const theme of THEMES) {
	test(`a long facet label stays on one line, truncated, inside the rail in the ${theme} theme`, async () => {
		assert.deepEqual(await facetLabelProblems({ theme }), []);
	});

	test(`the exclude control is never faded, in any isolated state, in the ${theme} theme`, async () => {
		assert.deepEqual(await fadedExcludeStates({ theme }), []);
	});

	test(`an excluded row's name and control are readable against the ${theme} theme`, {
		// Measured 4.22:1 on the light theme: `--warning` (oklch 0.62 0.15 70)
		// misses WCAG AA for small text on the light page. The token is shared
		// vendored brand data, so changing it is outside this PR; this case
		// flips to passing once the token is darkened upstream.
		todo:
			theme === "light"
				? "--warning is 4.22:1 on the light page, below 4.5:1"
				: false,
	}, async () => {
		assert.deepEqual(await excludedRowProblems({ theme }), []);
	});
}

/** Why the warning-coloured name and control of an excluded row are hard to read, if they are. */
async function excludedRowProblems(options: PageOptions): Promise<string[]> {
	return await withPage(
		await facetRowHtml(true),
		{ ...options, width: RAIL_WIDTH },
		async (page) => {
			const { backdrops, name, toggle } = await page.evaluate(() => {
				const label = document.querySelector(
					".rr-x-facet-row.is-excluded .rr-x-facet__name",
				);
				const control = document.querySelector(".rr-x-facet-not");
				if (!(label && control)) {
					throw new Error("the excluded row did not render");
				}
				const chain: string[] = [];
				for (
					let element: Element | null = label;
					element;
					element = element.parentElement
				) {
					chain.push(getComputedStyle(element).backgroundColor);
				}
				return {
					backdrops: chain.reverse(),
					name: getComputedStyle(label).color,
					toggle: getComputedStyle(control).color,
				};
			});
			// Lay the page's backgrounds over white, outermost first.
			let backdrop: Rgba = { a: 1, b: 255, g: 255, r: 255 };
			for (const css of backdrops) {
				backdrop = composite(await resolveColor(page, css), backdrop);
			}
			const problems: string[] = [];
			for (const [what, css] of [
				["name", name],
				["control", toggle],
			] as const) {
				const ratio = contrastRatio(
					composite(await resolveColor(page, css), backdrop),
					backdrop,
				);
				if (ratio < FACET_TEXT_MIN_CONTRAST) {
					problems.push(
						`the excluded row's ${what} contrast ${ratio.toFixed(2)}:1 is below 4.5:1`,
					);
				}
			}
			return problems;
		},
	);
}

// ── the harness itself ────────────────────────────────────────────

test("the dark theme tests really run under the dark tokens", async () => {
	const luminance: Record<Theme, number> = { dark: 1, light: 0 };
	for (const theme of THEMES) {
		luminance[theme] = await withPage("<p>x</p>", { theme }, async (page) => {
			const css = await page.evaluate(
				() => getComputedStyle(document.documentElement).backgroundColor,
			);
			return relativeLuminance(await resolveColor(page, css));
		});
	}
	assert.ok(
		luminance.light > 0.5,
		`light page is light (${luminance.light.toFixed(2)})`,
	);
	assert.ok(
		luminance.dark < 0.2,
		`dark page is dark (${luminance.dark.toFixed(2)})`,
	);
});

test("the page cannot reach the network", async () => {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		response.setHeader("access-control-allow-origin", "*");
		response.end("");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address() as AddressInfo;
		const origin = `http://127.0.0.1:${port}`;
		const fetched = await withPage(
			`<link rel="stylesheet" href="${origin}/sheet.css"><img alt="" src="${origin}/mark.png">`,
			{},
			(page) =>
				page.evaluate(
					(url) =>
						fetch(url).then(
							() => "reached",
							() => "blocked",
						),
					`${origin}/api`,
				),
		);
		assert.equal(fetched, "blocked");
		assert.deepEqual(requests, []);
	} finally {
		server.close();
	}
});

// ── a later override must bring the bug back as a failure ─────────

test("a later rule that lets the label wrap is detected, even when it says white-space: normal", async () => {
	const problems = await facetLabelProblems({
		extraCss: ".rr-x-facet__label { white-space: normal; }",
	});
	assert.match(problems.join("; "), /label wraps onto/);
});

test("the label stays on one line even if the name's own white-space is reset", async () => {
	assert.deepEqual(
		await facetLabelProblems({
			extraCss: ".rr-x-facet__name { white-space: normal; }",
		}),
		[],
	);
});

test("a later rule that stops the label truncating is detected", async () => {
	const problems = await facetLabelProblems({
		extraCss: ".rr-x-facet__label { overflow: visible; text-overflow: clip; }",
	});
	assert.deepEqual(problems, ["the truncated label has no ellipsis"]);
});

test("a later rule that fades the exclude control again is detected in every state", async () => {
	const faded = await fadedExcludeStates({
		extraCss: ".rr-x-facet-not { opacity: 0.45; }",
	});
	assert.equal(faded.length, CONTROL_STATES.length * 2);
});

test("a focus-only fade is detected even when a hover rule follows it", async () => {
	const faded = await fadedExcludeStates({
		extraCss:
			".rr-x-facet-not:focus { opacity: 0.45; } .rr-x-facet-not:hover { opacity: 1; }",
	});
	assert.ok(faded.some((entry) => entry.includes("[focus]")));
	assert.ok(!faded.some((entry) => entry.includes("[hover]")));
});

test("a hover-only fade is detected without disturbing the other states", async () => {
	const faded = await fadedExcludeStates({
		extraCss: ".rr-x-facet-row:hover .rr-x-facet-not { opacity: 0.8; }",
	});
	assert.ok(faded.some((entry) => entry.includes("[hover]")));
	assert.ok(!faded.some((entry) => entry.includes("[rest]")));
});

test("a later rule that washes out the excluded name is detected", async () => {
	const problems = await excludedRowProblems({
		extraCss:
			".rr-x-facet-row.is-excluded .rr-x-facet__name { color: var(--background); }",
	});
	assert.match(problems.join("; "), /name contrast 1\.00:1 is below 4\.5:1/);
});
