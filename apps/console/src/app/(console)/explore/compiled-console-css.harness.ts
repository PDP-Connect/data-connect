// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Computes the effective style of console markup under the CSS the console
 * ships: `globals.css` compiled by the same `@tailwindcss/postcss` pipeline
 * the app build uses, then cascaded by jsdom (selector matching, specificity,
 * source order, media queries, `!important`).
 *
 * jsdom ignores `@layer`, and the compiled stylesheet is layered. Layers are
 * flattened here without changing precedence: every selector gets one
 * `:not(#_)` per layer rank, because an id outranks any class or element
 * count, so a higher layer beats a lower one whatever its specificity, and
 * unlayered rules beat every layer. Source order breaks the remaining ties.
 *
 * Pseudo-classes jsdom cannot evaluate are swapped for attributes of equal
 * specificity (`:hover` -> `[data-hover]`) and `::selection` becomes a class,
 * so a test sets the attribute or class to ask "what is the style in this
 * state". Limits: no layout engine (a test reads `overflow` and
 * `text-overflow`, not pixel widths), and `!important` ignores layer order.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/postcss";
import { JSDOM } from "jsdom";
import postcss, { type AtRule, type Container } from "postcss";

const GLOBALS_CSS = fileURLToPath(
	new URL("../../globals.css", import.meta.url),
);

const STATE_PSEUDO_CLASSES: readonly [string, string][] = [
	[":focus-visible", "[data-focus-visible]"],
	[":focus-within", "[data-focus-within]"],
	[":focus", "[data-focus]"],
	[":hover", "[data-hover]"],
	[":active", "[data-active]"],
];

/** Element states a test can assert; see `StyleProbe.setState`. */
export type ProbeState =
	| "hover"
	| "focus"
	| "focus-visible"
	| "focus-within"
	| "active";

export const SELECTION_CLASS = "__selection__";

function enclosingLayer(node: Container | undefined): string | null {
	for (
		let parent = node;
		parent;
		parent = parent.parent as Container | undefined
	) {
		if (parent.type === "atrule" && (parent as AtRule).name === "layer") {
			return (parent as AtRule).params;
		}
	}
	return null;
}

/** Layer rank by first mention in `@layer a, b;` statements; unlayered ranks last. */
function layerRanks(root: postcss.Root): Map<string, number> {
	const ranks = new Map<string, number>();
	root.walkAtRules("layer", (atRule) => {
		for (const name of atRule.params.split(",")) {
			const layer = name.trim();
			if (layer && !ranks.has(layer)) {
				ranks.set(layer, ranks.size + 1);
			}
		}
	});
	return ranks;
}

export function flattenLayers(css: string): string {
	const root = postcss.parse(css);
	const ranks = layerRanks(root);
	const unlayeredRank = ranks.size + 1;
	root.walkRules((rule) => {
		if (rule.parent?.type === "rule") {
			return;
		}
		const layer = enclosingLayer(rule.parent);
		const rank = layer === null ? unlayeredRank : (ranks.get(layer) ?? 0);
		const boost = ":not(#_)".repeat(rank);
		rule.selectors = rule.selectors.map((selector) => {
			let swapped = selector.replaceAll("::selection", `.${SELECTION_CLASS}`);
			for (const [pseudo, attribute] of STATE_PSEUDO_CLASSES) {
				swapped = swapped.replaceAll(pseudo, attribute);
			}
			return `${swapped}${boost}`;
		});
	});
	// Tailwind emits colors with an opacity modifier as a plain fallback plus a
	// nested `@supports (color: color-mix(...))` override. Every engine the
	// console targets supports color-mix, so the override is the effective value.
	root.walkAtRules("supports", (atRule) => {
		if (
			atRule.parent?.type === "rule" &&
			atRule.params.includes("color-mix") &&
			atRule.nodes
		) {
			atRule.replaceWith(atRule.nodes);
		}
	});
	root.walkAtRules("layer", (atRule) => {
		if (atRule.nodes) {
			atRule.replaceWith(atRule.nodes);
		} else {
			atRule.remove();
		}
	});
	return root.toString();
}

/**
 * Keeps the `::selection` rules and the custom properties they read. The
 * probe for selected text is an ordinary element, and every other rule that
 * styles an element (its `color`, say) must not leak into what the browser
 * paints for the selection.
 */
function selectionRulesOnly(flattened: string): string {
	const root = postcss.parse(flattened);
	root.walkRules((rule) => {
		if (rule.selector.includes(SELECTION_CLASS)) {
			return;
		}
		rule.walkDecls((decl) => {
			if (!decl.prop.startsWith("--")) {
				decl.remove();
			}
		});
	});
	return root.toString();
}

let compiled: Promise<string> | undefined;

/** The stylesheet the console ships, as compiled. Compiled once per process. */
function shippedConsoleCss(): Promise<string> {
	compiled ??= postcss([tailwind()])
		.process(readFileSync(GLOBALS_CSS, "utf8"), { from: GLOBALS_CSS })
		.then((result) => result.css);
	return compiled;
}

export interface StyleProbe {
	/** Computed style of `selector`, with the given element states asserted. */
	style(selector: string, states?: readonly ProbeState[]): CSSStyleDeclaration;
	/** Computed style of what the user sees when text is selected inside `selector`. */
	selectionStyle(selector: string): CSSStyleDeclaration;
}

/** Mounts `html` under the shipped CSS in the given theme. */
export async function mountUnderShippedCss(
	html: string,
	theme: "light" | "dark",
	/** CSS appended after the shipped sheet, to model a later override. */
	extraCss = "",
): Promise<StyleProbe> {
	const flattened = flattenLayers((await shippedConsoleCss()) + extraCss);
	const mount = (css: string) => {
		const dom = new JSDOM(
			`<!doctype html><html data-theme="${theme}"><head></head><body>${html}</body></html>`,
		);
		const style = dom.window.document.createElement("style");
		style.textContent = css;
		dom.window.document.head.append(style);
		return dom.window;
	};
	const { document, getComputedStyle } = mount(flattened);
	const one = (selector: string): Element => {
		const element = document.querySelector(selector);
		if (!element) {
			throw new Error(`nothing matches ${selector}`);
		}
		return element;
	};
	return {
		selectionStyle(selector) {
			const selectionWindow = mount(selectionRulesOnly(flattened));
			const target = selectionWindow.document.querySelector(selector);
			if (!target) {
				throw new Error(`nothing matches ${selector}`);
			}
			const probe = selectionWindow.document.createElement("span");
			probe.className = SELECTION_CLASS;
			target.append(probe);
			return selectionWindow.getComputedStyle(probe);
		},
		style(selector, states = []) {
			// A state on the element is also a state of its ancestors for :hover
			// and :focus-within, so set it on the whole chain.
			for (
				let node: Element | null = one(selector);
				node;
				node = node.parentElement
			) {
				for (const state of states) {
					node.setAttribute(`data-${state}`, "");
				}
			}
			return getComputedStyle(one(selector));
		},
	};
}
