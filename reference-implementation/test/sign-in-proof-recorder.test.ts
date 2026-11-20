// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderInvalidationProof } from "../runtime/browser-surface/repair-decision.ts";
import { recordSignInProofAfterRun } from "../runtime/browser-surface/sign-in-proof-recorder.ts";
import type { ProviderInvalidationProofStore } from "../server/stores/provider-invalidation-proof-store.ts";

const WITH_PATTERN = {
	runtime_requirements: {
		bindings: {
			browser: { sign_in_url_pattern: "https://accounts.example.test/signin*" },
		},
	},
};
const WITHOUT_PATTERN = { runtime_requirements: { bindings: { browser: {} } } };

function fakeStore() {
	const recorded: ProviderInvalidationProof[] = [];
	const repaired: string[] = [];
	const store = {
		load: () => Promise.reject(new Error("unused")),
		markRepaired: (connectionId: string) => {
			repaired.push(connectionId);
			return Promise.resolve();
		},
		record: (proof: ProviderInvalidationProof) => {
			recorded.push(proof);
			return Promise.resolve();
		},
	} as unknown as ProviderInvalidationProofStore;
	return { recorded, repaired, store };
}

const base = {
	cdpUrl: "http://127.0.0.1:1",
	connectionId: "cin_1",
	connectorId: "c",
	nowIso: "2026-05-20T12:00:00.000Z",
	runId: "run_1",
};

test("a succeeded run repairs old proofs even after the manifest pattern was removed", async () => {
	const { repaired, store } = fakeStore();
	const outcome = await recordSignInProofAfterRun(
		{ store },
		{ ...base, manifest: WITHOUT_PATTERN, status: "succeeded" },
	);
	assert.equal(outcome, "repaired");
	assert.deepEqual(repaired, ["cin_1"]);
});

test("a capture that finished after its run was superseded writes nothing", async () => {
	const { recorded, store } = fakeStore();
	let current = true;
	const fetchImpl = (() => {
		current = false; // the run is reclaimed while the DevTools read is in flight
		return Promise.resolve(
			new Response(
				JSON.stringify([
					{ type: "page", url: "https://accounts.example.test/signin?x=1" },
				]),
			),
		);
	}) as unknown as typeof fetch;
	const outcome = await recordSignInProofAfterRun(
		{ fetchImpl, store },
		{
			...base,
			isCurrent: () => current,
			manifest: WITH_PATTERN,
			status: "failed",
		},
	);
	assert.equal(outcome, "none");
	assert.deepEqual(recorded, []);
});
