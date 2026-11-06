// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs console markup in a real browser under the CSS the console ships:
 * `globals.css` compiled by the same `@tailwindcss/postcss` pipeline the app
 * build uses. The browser does the cascading (layers, specificity, source
 * order, `!important`, pseudo-elements, interaction states), so a test reads
 * what a user would see and no second cascade lives here.
 *
 * The browser is the Google Chrome installed on the machine (GitHub's hosted
 * runners include it; elsewhere install it, or run
 * `npx playwright-core install chrome`). It is not the Chromium the e2e tier
 * downloads: that would need an install step in the console CI job. When no
 * Chrome is found the launch fails loudly: a silently skipped readability
 * test would hide the regression it guards.
 *
 * The page cannot reach the network. The sheet and markup are inline, and any
 * other request is aborted, so a future external `@import` or font URL fails
 * a test instead of making it depend on the network.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/postcss";
import { type Browser, chromium, type Page } from "playwright-core";
import postcss from "postcss";

const GLOBALS_CSS = fileURLToPath(
	new URL("../../globals.css", import.meta.url),
);

let compiled: Promise<string> | undefined;

/** The stylesheet the console ships, as compiled. Compiled once per process. */
function shippedConsoleCss(): Promise<string> {
	compiled ??= postcss([tailwind()])
		.process(readFileSync(GLOBALS_CSS, "utf8"), { from: GLOBALS_CSS })
		.then((result) => result.css);
	return compiled;
}

export function launchBrowser(): Promise<Browser> {
	// --no-sandbox: hosted Ubuntu runners and test sandboxes block the
	// unprivileged user namespaces Chrome's sandbox needs. The page only ever
	// holds our own inline markup and cannot navigate or fetch (see above).
	return chromium
		.launch({ args: ["--no-sandbox"], channel: "chrome" })
		.catch((cause: unknown) => {
			throw new Error(
				"These tests need an installed Google Chrome (playwright channel 'chrome'). " +
					"Install Chrome, or run `npx playwright-core install chrome`.",
				{ cause },
			);
		});
}

export interface PageOptions {
	/** CSS appended after the shipped sheet, to model a later override. */
	extraCss?: string;
	theme?: "light" | "dark";
	/** Width of the container the markup is mounted in, in CSS pixels. */
	width?: number;
}

/**
 * Opens a page whose body holds `html` in a container of `width`, under the
 * shipped CSS and the given theme. Transitions are off so a state is read
 * where it settles, not part-way through a fade.
 */
export async function openShippedPage(
	browser: Browser,
	html: string,
	{ extraCss = "", theme = "light", width = 800 }: PageOptions = {},
): Promise<Page> {
	const page = await browser.newPage({
		viewport: { height: 600, width: 1000 },
	});
	await page.route("**/*", (route) => route.abort());
	await page.setContent(
		`<!doctype html><html data-theme="${theme}"><head><style>${await shippedConsoleCss()}</style>` +
			`<style>${extraCss}</style>` +
			"<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>" +
			`</head><body><div id="mount" style="width:${width}px">${html}</div></body></html>`,
	);
	return page;
}

export interface Rgba {
	a: number;
	b: number;
	g: number;
	r: number;
}

/**
 * The sRGB value the browser paints for any CSS colour string. A canvas does
 * the conversion because `getComputedStyle` keeps the authored colour space:
 * the brand tokens are `oklch(...)`, and Chrome reports them as `oklch(...)`,
 * not as `rgb(...)`.
 */
export function resolveColor(page: Page, value: string): Promise<Rgba> {
	return page.evaluate((css) => {
		const context = document.createElement("canvas").getContext("2d", {
			willReadFrequently: true,
		});
		if (!context) {
			throw new Error("no 2d canvas");
		}
		const sentinel = "#123456";
		context.fillStyle = sentinel;
		context.fillStyle = css;
		if (context.fillStyle === sentinel) {
			throw new Error(`the browser could not parse the colour "${css}"`);
		}
		context.fillRect(0, 0, 1, 1);
		const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
		return { a: a / 255, b, g, r };
	}, value);
}
