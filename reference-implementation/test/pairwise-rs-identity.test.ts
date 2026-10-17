// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	pairwiseClientReadMap,
	pairwiseOwnerReadMap,
	parsePairwiseReadSelector,
} from "../server/pairwise-rs-identity.ts";

const ownerBindings = [
	{ instance_id: "public-a", rs_instance: "cin_a", source_id: "source-a" },
	{ instance_id: "public-b", rs_instance: "cin_b", source_id: "source-a" },
];

test("pairwise detail selector accepts equal aliases and rejects duplicates, conflicts, and raw IDs", () => {
	const ownerMap = pairwiseOwnerReadMap({
		pdpp_instance_bindings: ownerBindings,
	});
	assert.deepEqual(
		parsePairwiseReadSelector(
			{ instance_id: "public-a", connection_id: "public-a" },
			ownerMap,
		),
		{ handle: "public-a", internalId: "cin_a" },
	);
	for (const query of [
		{ instance_id: ["public-a", "public-a"] },
		{ instance_id: "public-a", connection_id: "public-b" },
		{ instance_id: "" },
		{ instance_id: "cin_a" },
	]) {
		assert.throws(() => parsePairwiseReadSelector(query, ownerMap));
	}
	assert.throws(() => parsePairwiseReadSelector({}, ownerMap));
});

test("client detail map rejects an invalid unselected binding before narrowing", () => {
	const token = {
		client_id: "client-a",
		subject_id: "owner-a",
		grant: {
			source: { id: "source-a" },
			streams: [{ instance_ids: ["public-a", "public-b"], name: "items" }],
		},
		pdpp_instance_bindings: [
			{
				instance_id: "public-a",
				rs_instance: "cin_a",
				source_id: "source-a",
				stream: "items",
			},
			{
				instance_id: "public-b",
				rs_instance: "cin_b",
				source_id: "source-wrong",
				stream: "items",
			},
		],
	};
	assert.throws(() => pairwiseClientReadMap(token, "source-a", "items"));
});
