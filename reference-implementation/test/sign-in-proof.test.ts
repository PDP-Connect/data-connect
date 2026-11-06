// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveSignInProof,
	observeLastTopLevelUrl,
	signInUrlMatchesPattern,
	signInUrlPatternFromManifest,
} from "../runtime/browser-surface/sign-in-proof.ts";
import { validateRuntimeRequirements } from "../server/connector-manifest-validation.ts";

const PATTERN = "https://accounts.example.test/signin*";
const base = {
	connectionId: "c1",
	lastTopLevelUrl: "https://accounts.example.test/signin?x=1",
	observedAt: "2026-05-20T12:00:00.000Z",
	pattern: PATTERN,
	provider: "p",
	runFailed: true,
	runId: "r1",
};

test("a proof needs a failed run and a last top-level URL that matches the declared pattern", () => {
	assert.equal(deriveSignInProof(base)?.evidence_id, "r1");
	assert.equal(deriveSignInProof({ ...base, runFailed: false }), null);
	assert.equal(
		deriveSignInProof({
			...base,
			lastTopLevelUrl: "https://app.example.test/home",
		}),
		null,
	);
	assert.equal(deriveSignInProof({ ...base, lastTopLevelUrl: null }), null);
	assert.equal(deriveSignInProof({ ...base, pattern: null }), null);
});

test("the pattern is an anchored glob with literal dots", () => {
	assert.equal(
		signInUrlMatchesPattern(PATTERN, "https://accounts.example.test/signin"),
		true,
	);
	assert.equal(
		signInUrlMatchesPattern(PATTERN, "https://accountsXexample.test/signin"),
		false,
	);
	assert.equal(
		signInUrlMatchesPattern(
			PATTERN,
			"https://evil.test/?https://accounts.example.test/signin",
		),
		false,
	);
});

test("the manifest pattern is read from the browser binding only", () => {
	const manifest = {
		runtime_requirements: {
			bindings: { browser: { required: true, sign_in_url_pattern: PATTERN } },
		},
	};
	assert.equal(signInUrlPatternFromManifest(manifest), PATTERN);
	assert.equal(
		signInUrlPatternFromManifest({
			runtime_requirements: { bindings: { browser: { required: true } } },
		}),
		null,
	);
});

test("manifest validation rejects a non-string sign_in_url_pattern", () => {
	assert.throws(() =>
		validateRuntimeRequirements(
			{
				runtime_requirements: {
					bindings: { browser: { required: true, sign_in_url_pattern: 5 } },
				},
			},
			"invalid_connector_manifest",
		),
	);
	assert.doesNotThrow(() =>
		validateRuntimeRequirements(
			{
				runtime_requirements: {
					bindings: {
						browser: { required: true, sign_in_url_pattern: PATTERN },
					},
				},
			},
			"invalid_connector_manifest",
		),
	);
});

test("the surface observation reads the first http(s) page target and nothing else", async () => {
	const targets = [
		{ type: "service_worker", url: "https://a.test/sw.js" },
		{ type: "page", url: "about:blank" },
		{ type: "page", url: "https://accounts.example.test/signin" },
	];
	const fetchImpl = (() =>
		Promise.resolve(Response.json(targets))) as typeof fetch;
	assert.equal(
		await observeLastTopLevelUrl("http://127.0.0.1:9222", fetchImpl),
		"https://accounts.example.test/signin",
	);
});
