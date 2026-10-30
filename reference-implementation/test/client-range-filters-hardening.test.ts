// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	compileClientRangeFilters,
	exactStoredRecord,
	type FrozenStream,
} from "../server/client-range-filters.ts";
import { parseTopLevelWithNumbers } from "../server/lossless-json.ts";
import { passesRequestFilters } from "../server/record-filters.ts";
import { rememberRecordSourceText } from "../server/record-source-text.ts";
import { deleteRecord } from "../server/records.ts";
import {
	fetchJson,
	issueClientGrant,
	loadVectors,
	manifestFor,
	materializeConnection,
	registerManifest,
	seedRecords,
	setGrantExtensions,
	startWorld,
} from "./helpers/client-range-filters-harness.ts";

const frozen: FrozenStream = new Map([
	["amount", { ops: new Set(["lte"] as const), type: "number" }],
]);

function compiledFilter(value: string) {
	const compiled = compileClientRangeFilters(
		[["filter[amount][lte]", value]],
		frozen,
	);
	assert.equal(compiled.ok, true);
	return compiled.ok
		? [
				{
					field: "" as const,
					filters: compiled.filters,
					kind: "client_range" as const,
				},
			]
		: [];
}

function stored(text: string) {
	return rememberRecordSourceText(
		JSON.parse(text) as Record<string, unknown>,
		text,
	);
}

test("an exact top-level number survives arbitrarily deep unrelated nesting", () => {
	const deep = `${"[".repeat(5000)}0${"]".repeat(5000)}`;
	const text = `{"id":"a","amount":9007199254740993,"hidden":${deep}}`;
	assert.equal(exactStoredRecord(text).id, "a");
	const filters = compiledFilter("9007199254740992");
	assert.equal(
		passesRequestFilters(stored(text), filters),
		false,
		"9007199254740993 is above the bound",
	);
	assert.equal(
		passesRequestFilters(
			stored(`{"amount":9007199254740992,"hidden":${deep}}`),
			filters,
		),
		true,
	);
});

test("a record whose text cannot be read exactly fails the filter instead of falling back to rounded data", () => {
	const filters = compiledFilter("9007199254740992");
	const data = rememberRecordSourceText({ amount: 1 }, '{"amount":1,');
	assert.equal(passesRequestFilters(data, filters), false);
});

test("the top-level scan agrees with JSON.parse on everything except number lexemes", () => {
	const text =
		'{"a":"x\\"y","b":[1,{"c":"]"}],"c":{"d":"}"},"e":null,"f":true,"g":-1.5e2,"__proto__":3}';
	const exact = parseTopLevelWithNumbers(text, (lexeme) => Number(lexeme));
	const reference = JSON.parse(text) as Record<string, unknown>;
	assert.equal(exact.a, reference.a);
	assert.equal(exact.e, null);
	assert.equal(exact.f, true);
	assert.equal(exact.g, -150);
	assert.deepEqual(Object.keys(exact), Object.keys(reference));
	assert.deepEqual(exact.b, []);
	assert.deepEqual(exact.c, {});
	assert.equal(Object.getPrototypeOf(exact), Object.prototype);
	assert.equal(Object.hasOwn(exact, "__proto__"), true);
});

test("a requested field outside the grant and an invented one take the same path", async () => {
	const { file, exactRecords } = loadVectors();
	const fixture = file.fixtures.base;
	assert.ok(fixture);
	const world = await startWorld();
	try {
		await registerManifest(
			world,
			manifestFor(fixture.retained_declaration, "oracle.v1"),
		);
		await materializeConnection("inst_a");
		await seedRecords(
			fixture.records,
			exactRecords.get("base#") as Map<string, string>,
		);
		const grant = await issueClientGrant(world, fixture.grant);
		setGrantExtensions(
			grant.grantId,
			fixture.grant.extensions as Record<string, unknown>,
		);
		const read = (field: string) =>
			fetchJson(
				`${world.rsUrl}/v1/streams/transactions/records?fields=${field}`,
				{
					headers: { Authorization: `Bearer ${grant.token}` },
				},
			);
		// `secret` is in the declaration but not in the grant; `invented` is in neither.
		const [real, invented] = [await read("secret"), await read("invented")];
		assert.equal(real.status, invented.status);
		assert.equal(real.body.error.code, invented.body.error.code);
		assert.equal(
			real.body.error.message.replace("secret", "X"),
			invented.body.error.message.replace("invented", "X"),
		);
	} finally {
		await world.close();
	}
});

test("a physical deletion in a filtered sync session is a bare tombstone, like a range exit", async () => {
	const { file, exactRecords } = loadVectors();
	const fixture = file.fixtures.sync;
	assert.ok(fixture);
	const world = await startWorld();
	try {
		await registerManifest(
			world,
			manifestFor(fixture.retained_declaration, "delete.v1"),
		);
		await materializeConnection("inst_a");
		await seedRecords(
			fixture.records,
			exactRecords.get("sync#") as Map<string, string>,
		);
		const grant = await issueClientGrant(world, fixture.grant);
		setGrantExtensions(
			grant.grantId,
			fixture.grant.extensions as Record<string, unknown>,
		);
		const headers = { Authorization: `Bearer ${grant.token}` };
		const filter = "filter%5Bamount%5D%5Blte%5D=0.3";
		const first = await fetchJson(
			`${world.rsUrl}/v1/streams/transactions/records?changes_since=beginning&${filter}`,
			{ headers },
		);
		assert.equal(first.status, 200);
		const [victim] = first.body.data;
		await deleteRecord(
			{ connector_id: "spotify", connector_instance_id: "inst_a" } as never,
			"transactions",
			victim.id,
		);
		// A record outside the filter range never reached this client, so
		// deleting it reports nothing.
		await deleteRecord(
			{ connector_id: "spotify", connector_instance_id: "inst_a" } as never,
			"transactions",
			"never",
		);
		const second = await fetchJson(
			`${world.rsUrl}/v1/streams/transactions/records?changes_since=${first.body.next_changes_since}&${filter}`,
			{ headers },
		);
		const tombstone = second.body.data.find(
			(record: { id: string }) => record.id === victim.id,
		);
		assert.equal(tombstone?.deleted, true);
		for (const member of ["data", "deleted_at", "emitted_at"]) {
			assert.equal(
				Object.hasOwn(tombstone, member),
				false,
				`tombstone must not carry ${member}`,
			);
		}
		assert.deepEqual(
			second.body.data.map((record: { id: string }) => record.id),
			[victim.id],
			"only the matching record's deletion is reported",
		);
	} finally {
		await world.close();
	}
});
