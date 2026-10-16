// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	BROWSER_DISPLAY_BACKENDS,
	BROWSER_ENGINE_MODES,
	BROWSER_INTERACTION_PRESENTATIONS,
	BROWSER_NATIVE_VISIBILITIES,
	BROWSER_PRESENTATION_FALLBACKS,
	BrowserPresentationPolicyError,
	parseBrowserPresentationPolicy,
	parseBrowserPresentationPolicyEnv,
} from "./browser-presentation-policy.ts";

interface FixtureCase {
	readonly error: string | null;
	readonly name: string;
	readonly policy: unknown;
}

// The desktop host's Rust parser reads this same file
// (src-tauri/src/commands/browser_presentation.rs).
const fixtures = JSON.parse(
	readFileSync(
		new URL("./browser-presentation-policy.fixtures.json", import.meta.url),
		"utf8",
	),
) as { readonly cases: readonly FixtureCase[] };

const PRIVATE_XVFB = {
	display_backend: "private-xvfb",
	engine_mode: "headed",
	fallback: "fail-closed",
	interaction_presentation: "companion",
	native_visibility: "isolated-display",
	version: 1,
} as const;

// A case that names one point of the version 1 enum space: an object with
// exactly the six v1 fields, each holding a known value.
function enumCombinationKey(policy: unknown): string | null {
	if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
		return null;
	}
	const record = policy as Record<string, unknown>;
	const spaces: Record<string, readonly string[]> = {
		display_backend: BROWSER_DISPLAY_BACKENDS,
		engine_mode: BROWSER_ENGINE_MODES,
		fallback: BROWSER_PRESENTATION_FALLBACKS,
		interaction_presentation: BROWSER_INTERACTION_PRESENTATIONS,
		native_visibility: BROWSER_NATIVE_VISIBILITIES,
	};
	if (record.version !== 1) return null;
	if (Object.keys(record).length !== Object.keys(spaces).length + 1) {
		return null;
	}
	const parts: string[] = [];
	for (const [field, values] of Object.entries(spaces)) {
		const value = record[field];
		if (typeof value !== "string" || !values.includes(value)) return null;
		parts.push(value);
	}
	return parts.join("/");
}

test("shared fixtures cover every v1 enum combination exactly once", () => {
	const expected = new Set<string>();
	for (const engine of BROWSER_ENGINE_MODES)
		for (const display of BROWSER_DISPLAY_BACKENDS)
			for (const visibility of BROWSER_NATIVE_VISIBILITIES)
				for (const interaction of BROWSER_INTERACTION_PRESENTATIONS)
					for (const fallback of BROWSER_PRESENTATION_FALLBACKS)
						expected.add(
							[display, engine, fallback, interaction, visibility].join("/"),
						);
	assert.equal(expected.size, 36);
	const seen = new Map<string, number>();
	for (const fixture of fixtures.cases) {
		const key = enumCombinationKey(fixture.policy);
		if (key !== null) seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	assert.deepEqual([...seen.keys()].sort(), [...expected].sort());
	for (const [key, count] of seen) {
		assert.equal(count, 1, `combination ${key} appears ${count} times`);
	}
});

test("shared fixtures give the same verdict as the desktop host parser", () => {
	for (const fixture of fixtures.cases) {
		if (fixture.error === null) {
			assert.deepEqual(
				parseBrowserPresentationPolicy(fixture.policy),
				fixture.policy,
				fixture.name,
			);
			continue;
		}
		assert.throws(
			() => parseBrowserPresentationPolicy(fixture.policy),
			(error: unknown) =>
				error instanceof BrowserPresentationPolicyError &&
				error.code === fixture.error,
			fixture.name,
		);
	}
});

test("the env form is JSON, and blank means no policy", () => {
	assert.equal(parseBrowserPresentationPolicyEnv(undefined), undefined);
	assert.equal(parseBrowserPresentationPolicyEnv("  "), undefined);
	assert.deepEqual(
		parseBrowserPresentationPolicyEnv(JSON.stringify(PRIVATE_XVFB)),
		PRIVATE_XVFB,
	);
	assert.throws(
		() => parseBrowserPresentationPolicyEnv("private-xvfb"),
		(error: unknown) =>
			error instanceof BrowserPresentationPolicyError &&
			error.code === "invalid_shape",
	);
});
