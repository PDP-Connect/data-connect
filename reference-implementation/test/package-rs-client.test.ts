// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createPackageProfile } from "../server/package-rs-client.ts";

const PROVIDER = "https://rs.test";

function member(grant_id: string, token: string) {
	return {
		access_mode: "continuous",
		active: true,
		connection_id: `pairwise-${grant_id}`,
		grant: {
			purpose: "personal records",
			streams: [{ name: "notes", instance_ids: [`pairwise-${grant_id}`] }],
		},
		grant_id,
		package_id: "package-test",
		source: {
			connection_id: `pairwise-${grant_id}`,
			id: `source-${grant_id}`,
			kind: "connector" as const,
		},
		token,
	};
}

test("package profile keeps each child bound to its own RS bearer", async () => {
	const calls: Array<{ authorization: string | null; url: string }> = [];
	const profile = createPackageProfile({
		fetch: async (input, init) => {
			calls.push({
				authorization: new Headers(init?.headers).get("authorization"),
				url: String(input),
			});
			return Response.json({ object: "schema", streams: [] });
		},
		members: [
			member("child-A", "token-A"),
			member("child.B", "token-B"),
		],
		providerUrl: PROVIDER,
	});

	assert.equal(profile.children.length, 2);
	await profile.children[0]!.rs.getJson("/v1/schema");
	await profile.children[1]!.rs.getJson("/v1/schema");
	assert.deepEqual(
		calls.map(({ authorization }) => authorization),
		["Bearer token-A", "Bearer token-B"],
	);
});

test("package profile requires at least one active child", () => {
	assert.throws(
		() => createPackageProfile({ members: [], providerUrl: PROVIDER }),
		/at least one active member/,
	);
});
