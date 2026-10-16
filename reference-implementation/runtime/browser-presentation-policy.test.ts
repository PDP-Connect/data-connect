// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
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

test("shared fixtures give the same verdict as the desktop host parser", () => {
	assert.ok(fixtures.cases.length >= 20, "fixture file lost its cases");
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
