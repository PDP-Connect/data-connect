// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	CLIENT_RANGE_FILTERS_PROFILE_URI as URI,
	clientRangeFiltersRsCapability,
	parseFrozenFilterSet,
	compileClientRangeFilters,
	matchesClientRangeFilters,
	clientFilterSetKey,
	frozenStreamMetadata,
	type FrozenStream,
	type RangeType,
} from "../server/client-range-filters.js";

const ops = ["gte", "gt", "lte", "lt"] as const;
function stream(type: RangeType = "number"): FrozenStream {
	return new Map([["x", { type, ops: new Set(ops) }]]);
}
function compile(value: string, type: RangeType = "number", op = "gte") {
	return compileClientRangeFilters([["filter[x][" + op + "]", value]], stream(type));
}
function filters(value: string, type: RangeType = "number", op = "gte") {
	const result = compile(value, type, op);
	if (!result.ok) throw new Error(result.error.message);
	return result.filters;
}

test("capability, absent profile and strict frozen validation", () => {
	assert.deepEqual(clientRangeFiltersRsCapability(), { supported: true, stability: "experimental", profile: URI });
	for (const ext of [undefined, {}, { other: {} }]) assert.deepEqual(parseFrozenFilterSet(ext, []), { kind: "absent" });
	const valid = { streams: { s: { x: { type: "number", ops: ["gte"], extra: true } } }, extra: [] };
	assert.equal(parseFrozenFilterSet({ [URI]: valid }, [{ name: "s", fields: ["x"] }]).kind, "ok");
	for (const fields of [undefined, null]) assert.equal(parseFrozenFilterSet({ [URI]: valid }, [{ name: "s", fields }]).kind, "ok");
	assert.equal(parseFrozenFilterSet({ [URI]: valid }, []).kind, "malformed");
	assert.equal(parseFrozenFilterSet({ [URI]: valid }, [{ name: "s", fields: [] }]).kind, "malformed");
	const descriptors: unknown[] = [null, [], 1, {}, { type: 1, ops: ["gte"] }, { ops: ["gte"] }, { type: "number" }, { type: "number", ops: "gte" }, { type: "number", ops: [] }, { type: "string", ops: ["gte"] }, { type: "number", ops: ["eq"] }, { type: "number", ops: ["gte", "gte"] }];
	const profiles: unknown[] = [null, [], 1, {}, { streams: {} }, { streams: [] }, { streams: null }, { streams: { s: {} } }, { streams: { s: [] } }, { streams: { s: null } }, ...descriptors.map(x => ({ streams: { s: { x } } }))];
	for (const profile of profiles) assert.equal(parseFrozenFilterSet({ [URI]: profile }, [{ name: "s", fields: ["x"] }]).kind, "malformed", JSON.stringify(profile));
});

test("syntax, duplicates, no frozen set, and authorization before values", () => {
	for (const name of ["filter", "filter[x]", "filter[x][]", "filter[x][gte][]", "filter[a.b][gte]", "filter[a][b][c]", "filter[]", "filters"]) {
		assert.equal(compileClientRangeFilters([[name, "1"]], stream()).ok, false, name);
	}
	assert.equal(compileClientRangeFilters([["limit", "1"]], undefined).ok, true);
	assert.equal(compileClientRangeFilters([["filter[x][gte]", "1"]], undefined).ok, false);
	assert.equal(compileClientRangeFilters([["filter[x][gte]", "1"], ["filter[x][gte]", "2"]], stream()).ok, false);
	const query: Array<[string, string]> = [["filter[probe][gte]", "NaN"]];
	const outcomes = [undefined, new Map(), stream()].map(s => compileClientRangeFilters(query, s));
	assert.deepEqual(outcomes[0], outcomes[1]);
	assert.deepEqual(outcomes[1], outcomes[2]);
	assert.deepEqual(compileClientRangeFilters([["filter[x][eq]", "bad"]], stream()), compileClientRangeFilters([["filter[x][eq]", "1"]], stream()));
});

test("RFC 8259 grammar and exact mathematical integers", () => {
	for (const value of ["+1", "01", "-01", ".5", "5.", " 1", "1 ", "1\n", "NaN", "Infinity", "-Infinity", "0x10", "", "1e", "--1"]) {
		assert.equal(compile(value).ok, false, value);
	}
	for (const value of ["0", "-0", "1e0", "10e-1", "1.00", "100e-2", "1e99999999999999999999"]) assert.equal(compile(value, "integer").ok, true, value);
	for (const value of ["1.5", "1e-1", "10e-2"]) assert.equal(compile(value, "integer").ok, false, value);
	const parsed = filters("1.20e1")[0]!;
	assert.equal(typeof parsed.value.coefficient, "bigint");
	assert.equal(parsed.value.coefficient, 12n);
	assert.equal(parsed.value.exponent, 0n);
});

test("exact decimals, invalid stored types, AND, and explicit lossless decimal adapter", () => {
	const bound = filters("0.3", "number", "lte");
	assert.equal(matchesClientRangeFilters({ x: 0.3 }, bound), true);
	assert.equal(matchesClientRangeFilters({ x: 0.1 + 0.2 }, bound), false);
	for (const x of [undefined, null, "0.2", false, [], {}, Infinity, NaN]) assert.equal(matchesClientRangeFilters({ x }, bound), false);
	assert.equal(matchesClientRangeFilters({}, bound), false);
	assert.equal(matchesClientRangeFilters({ x: 1.5 }, filters("1", "integer")), false);
	assert.equal(matchesClientRangeFilters({ x: { kind: "decimal", coefficient: 9007199254740993n, exponent: 0n } }, filters("9007199254740992", "number", "lte")), false);
	assert.equal(matchesClientRangeFilters({ x: { kind: "decimal", coefficient: 10n, exponent: -1n } }, filters("1", "integer", "lte")), true);
	assert.equal(matchesClientRangeFilters({ x: 1 }, [...filters("2"), ...filters("0", "number", "lte")]), false);
	assert.equal(matchesClientRangeFilters({}, []), true);
	assert.equal(matchesClientRangeFilters({ x: -1 }, filters("-2")), true);
	assert.equal(matchesClientRangeFilters({ x: 1 }, filters("1e99999999999999999999", "number", "lt")), true);
});

test("calendar dates, offsets, fractional instants and wrong temporal types", () => {
	for (const value of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-01", "2026-01-00", "2026-01-10T00:00:00Z", "2026-1-01"]) assert.equal(compile(value, "date").ok, false, value);
	assert.equal(compile("2024-02-29", "date").ok, true);
	for (const value of ["2026-01-10", "2026-02-30T00:00:00Z", "2026-01-10T00:00:00", "2026-01-10T24:00:00Z", "2026-01-10T00:60:00Z", "2026-01-10T00:00:00+24:00", "2026-01-10T23:59:60Z"]) assert.equal(compile(value, "date-time").ok, false, value);
	const bound = filters("2026-01-10T00:00:00.000000001Z", "date-time");
	assert.equal(matchesClientRangeFilters({ x: "2026-01-10T01:00:00+01:00" }, bound), false);
	assert.equal(matchesClientRangeFilters({ x: "2026-01-10T00:00:00.000000001Z" }, bound), true);
	assert.equal(matchesClientRangeFilters({ x: "2026-01-10T00:00:00.0000000009Z" }, bound), false);
	assert.equal(matchesClientRangeFilters({ x: "2026-01-10T01:00:00+01:00" }, filters("2026-01-10T00:00:00Z", "date-time", "lte")), true);
	for (const x of [123, null, "2026-02-30", "2026-01-10T00:00:00Z"]) assert.equal(matchesClientRangeFilters({ x }, filters("2026-01-01", "date")), false);
	assert.equal(matchesClientRangeFilters({ x: "0000-01-01" }, filters("0001-01-01", "date", "lt")), true);
});

test("cursor binding uses unordered decoded text triples; metadata is frozen and ordered", () => {
	const a = [...filters("1"), ...filters("2", "number", "lte")];
	assert.equal(clientFilterSetKey(a), clientFilterSetKey([...a].reverse()));
	assert.notEqual(clientFilterSetKey(filters("1")), clientFilterSetKey(filters("1.0")));
	assert.notEqual(clientFilterSetKey(filters("1")), clientFilterSetKey(filters("1e0")));
	const frozen: FrozenStream = new Map([["__proto__", { type: "integer", ops: new Set(["lt", "gte"]) }]]);
	const metadata = frozenStreamMetadata(frozen);
	assert.equal(Object.hasOwn(metadata.range_filters, "__proto__"), true);
	assert.deepEqual(metadata.range_filters.__proto__, ["gte", "lt"]);
	assert.equal(metadata.range_filter_types.__proto__, "integer");
	assert.deepEqual(frozenStreamMetadata(undefined), { range_filters: {}, range_filter_types: {} });
});

// This adapter checks pure validation only. It never treats compilation success
// as proof of HTTP 200 or evaluates stored fixture numbers through JSON.parse.
interface Grant { streams: Array<{ name: string; fields?: string[] | null }>; extensions?: unknown; }
interface Fixture { grant: Grant; children?: Record<string, Fixture>; }
interface Vector {
	id: string; fixture: string; requirements: string[];
	request: { path?: string; query?: Array<[string, string]>; token?: { kind: string; selected_child?: string } };
	expected: { status?: number; error?: string; record_keys?: string[] };
}
const suite = JSON.parse(readFileSync(new URL("./fixtures/client-range-filters/client-range-filters-0.1-experimental.json", import.meta.url), "utf8")) as { fixtures: Record<string, Fixture>; vectors: Vector[] };
test("bundled vectors: pure validation outcomes and explicit coverage accounting", async t => {
	let covered = 0;
	const skipped: Record<string, number> = {};
	for (const vector of suite.vectors) {
		const selected = vector.requirements.some(r => ["CRF-RS-4", "CRF-RS-5", "CRF-RS-6"].includes(r)) || (vector.requirements.includes("CRF-RS-2") && vector.fixture.startsWith("malformed"));
		const reason = !selected ? "outside pure validation requirements (HTTP/store/AS/client)" : vector.expected.status === 200 ? "successful response needs store/grant intersection" : undefined;
		if (reason) {
			skipped[reason] = (skipped[reason] ?? 0) + 1;
			await t.test(vector.id, { skip: reason }, () => {});
			continue;
		}
		await t.test(vector.id, () => {
			let fixture = suite.fixtures[vector.fixture]!;
			const child = vector.request.token?.selected_child;
			if (child) fixture = fixture.children![child]!;
			assert.ok(fixture?.grant, "fixture grant must exist");
			const parsed = parseFrozenFilterSet(fixture.grant.extensions, fixture.grant.streams);
			let actual: { status: number; error?: string };
			if (parsed.kind === "malformed") actual = { status: 403, error: "grant_invalid" };
			else {
				const streamName = /^\/v1\/streams\/([^/]+)\/records$/.exec(vector.request.path ?? "")?.[1];
				assert.ok(streamName, "pure adapter only accepts list-records vectors");
				const result = compileClientRangeFilters(vector.request.query ?? [], parsed.kind === "ok" ? parsed.streams.get(streamName) : undefined);
				actual = result.ok ? { status: 200 } : { status: result.error.status, error: result.error.code };
			}
			assert.deepEqual(actual, { status: vector.expected.status, error: vector.expected.error });
		});
		covered++;
	}
	t.diagnostic(JSON.stringify({ total: suite.vectors.length, covered, skipped }));
});

test("fixture classifications have identical complete errors and frozen metadata", () => {
	const errors = ["probe_unknown", "probe_ungranted", "probe_not_frozen"].map(name => {
		const grant = suite.fixtures[name]!.grant;
		const parsed = parseFrozenFilterSet(grant.extensions, grant.streams);
		assert.equal(parsed.kind, "ok");
		if (parsed.kind !== "ok") throw new Error("Expected valid fixture");
		return compileClientRangeFilters([["filter[probe][gte]", "1"]], parsed.streams.get("transactions"));
	});
	assert.deepEqual(errors[0], errors[1]);
	assert.deepEqual(errors[1], errors[2]);
	const grant = suite.fixtures.unknown_frozen_members!.grant;
	const parsed = parseFrozenFilterSet(grant.extensions, grant.streams);
	assert.equal(parsed.kind, "ok");
	if (parsed.kind !== "ok") throw new Error("Expected valid fixture");
	const metadata = frozenStreamMetadata(parsed.streams.get("transactions"));
	assert.deepEqual(metadata.range_filters.amount, ["gte", "lte"]);
	assert.equal(metadata.range_filter_types.amount, "number");
});

test("all comparison operators, negative decimals and pre-epoch fractions", () => {
	for (const [op, low, equal, high] of [["gte", false, true, true], ["gt", false, false, true], ["lte", true, true, false], ["lt", true, false, false]] as const) {
		const bound = filters("-1.2", "number", op);
		assert.equal(matchesClientRangeFilters({ x: -1.21 }, bound), low);
		assert.equal(matchesClientRangeFilters({ x: -1.2 }, bound), equal);
		assert.equal(matchesClientRangeFilters({ x: -1.19 }, bound), high);
	}
	assert.equal(matchesClientRangeFilters({ x: "1969-12-31T23:59:59.9Z" }, filters("1970-01-01T00:00:00Z", "date-time", "lt")), true);
	const inherited = Object.create({ x: 1 });
	assert.equal(matchesClientRangeFilters(inherited, filters("0")), false);
});

test("leap seconds: valid only on IERS days, ordered between :59 and the next minute (Core Time constraint semantics)", () => {
	// 2016-12-31T23:59:60Z is a real leap second; 2017-01-01T00:00:00Z follows it.
	assert.equal(compile("2016-12-31T23:59:60Z", "date-time").ok, true);
	assert.equal(compile("2016-12-31T23:59:60.5Z", "date-time").ok, true);
	// The same instant stated with an offset.
	assert.equal(compile("2017-01-01T00:59:60+01:00", "date-time").ok, true);
	// Not an inserted leap second.
	for (const value of ["2016-12-30T23:59:60Z", "2017-06-30T23:59:60Z", "2016-12-31T22:59:60Z", "2016-12-31T23:58:60Z", "2016-12-31T23:59:61Z"]) assert.equal(compile(value, "date-time").ok, false, value);
	const after59 = filters("2016-12-31T23:59:59.999999999Z", "date-time", "gt");
	assert.equal(matchesClientRangeFilters({ x: "2016-12-31T23:59:60Z" }, after59), true);
	const beforeNext = filters("2017-01-01T00:00:00Z", "date-time", "lt");
	assert.equal(matchesClientRangeFilters({ x: "2016-12-31T23:59:60.999Z" }, beforeNext), true);
	assert.equal(matchesClientRangeFilters({ x: "2017-01-01T00:00:00Z" }, beforeNext), false);
	// An ordinary instant after the leap second still orders after earlier ones.
	assert.equal(matchesClientRangeFilters({ x: "2017-01-01T00:00:00Z" }, filters("2016-12-31T23:59:60Z", "date-time", "gt")), true);
	// Equal instants in different offsets stay equal.
	assert.equal(matchesClientRangeFilters({ x: "2017-01-01T01:00:00+01:00" }, filters("2017-01-01T00:00:00Z", "date-time", "lte")), true);
	assert.equal(matchesClientRangeFilters({ x: "2017-01-01T01:00:00+01:00" }, filters("2017-01-01T00:00:00Z", "date-time", "gte")), true);
});
