// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs the resource-server and client vectors of the experimental client range
// filters profile (spec-client-range-filters.md Section 11.2 and 11.3) against a
// real reference server. The AS vectors run in client-range-filters-as.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { rsAdvertisesClientRangeFilters } from "../server/client-range-filters.ts";
import {
	responseMember,
	type Vector,
} from "./helpers/client-range-filters-harness.ts";
import {
	equivalenceGroups,
	file,
	runRsVector,
	startRsWorld,
	stopRsWorld,
} from "./helpers/client-range-filters-rs-runner.ts";

function isRsVector(vector: Vector): boolean {
	return !(vector.id.startsWith("as-") || vector.id.startsWith("client-"));
}

const vectorById = new Map(file.vectors.map((vector) => [vector.id, vector]));

test.before(startRsWorld);
test.after(stopRsWorld);

// A negative vector proves nothing alone, because Core already rejects every
// client filter. Its `control` (a positive vector, possibly on another fixture)
// must pass first in the same run, or the negative is inconclusive.
async function passControl(vector: Vector, ordinal: number): Promise<void> {
	const controlId = (vector as Vector & { control?: string }).control;
	if (!controlId) {
		return;
	}
	const control = vectorById.get(controlId);
	assert.ok(control, `${vector.id}: control ${controlId} exists`);
	assert.equal(
		control.expected?.status,
		200,
		`${controlId}: a control expects HTTP 200`,
	);
	await runRsVector(control, 1000 + ordinal);
}

for (const [ordinal, vector] of file.vectors.filter(isRsVector).entries()) {
	test(`vector ${vector.id} (${vector.requirements.join(", ")})`, async () => {
		await passControl(vector, ordinal);
		await runRsVector(vector, ordinal);
	});
}

test("vectors in one response equivalence group answer identically", () => {
	assert.ok(equivalenceGroups.size > 0, "at least one equivalence group ran");
	for (const [group, members] of equivalenceGroups) {
		const compared = (
			file.vectors.find((vector) => members[0]?.id === vector.id) as Vector & {
				compare_response_members?: string[];
			}
		).compare_response_members as string[];
		const [first, ...rest] = members;
		assert.ok(first && rest.length > 0, `${group}: needs two or more members`);
		for (const member of rest) {
			for (const path of compared) {
				assert.deepEqual(
					responseMember(member.response, path),
					responseMember(first.response, path),
					`${group}: ${member.id} differs from ${first.id} at ${path}`,
				);
			}
		}
	}
});

function clientSupports(vector: Vector): boolean {
	return rsAdvertisesClientRangeFilters(
		(vector.request as { metadata: unknown }).metadata,
	);
}

for (const vector of file.vectors.filter((candidate) =>
	candidate.id.startsWith("client-"),
)) {
	test(`vector ${vector.id} (${vector.requirements.join(", ")})`, () => {
		// A rejection counts only after its positive control is accepted.
		const controlId = (vector as Vector & { control?: string }).control;
		if (controlId) {
			const control = vectorById.get(controlId);
			assert.ok(control, `${vector.id}: control ${controlId} exists`);
			assert.equal(
				clientSupports(control),
				control.expected?.profile_supported,
			);
			assert.equal(
				control.expected?.profile_supported,
				true,
				`${controlId}: a client control is accepted`,
			);
		}
		assert.equal(clientSupports(vector), vector.expected?.profile_supported);
	});
}
