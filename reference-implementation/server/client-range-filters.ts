// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseTopLevelWithNumbers } from "./lossless-json.ts";

// Pure experimental profile primitives. Callers retain responsibility for
// endpoint applicability, grant intersection, serving availability and cursors.
export const CLIENT_RANGE_FILTERS_PROFILE_URI = "https://pdpp.dev/profiles/client-range-filters/0.1-experimental";
export type RangeType = "integer" | "number" | "date" | "date-time";
export type RangeOperator = "gte" | "gt" | "lte" | "lt";
export interface FrozenDescriptor { type: RangeType; ops: Set<RangeOperator>; }
export type FrozenStream = Map<string, FrozenDescriptor>;
export interface ExactDecimal { kind: "decimal"; coefficient: bigint; exponent: bigint; }
export type ParsedValue = ExactDecimal;
export interface ClientRangeFilter {
	field: string;
	op: RangeOperator;
	type: RangeType;
	value: ParsedValue;
	// Section 6.7 binds decoded text, not numeric/temporal equivalence.
	decodedValue: string;
}
export type FrozenFilterSet =
	| { kind: "absent" }
	| { kind: "malformed"; reason: string }
	| { kind: "ok"; streams: Map<string, FrozenStream> };
export type CompileResult =
	| { ok: true; filters: ClientRangeFilter[] }
	| { ok: false; error: { status: 400; code: "invalid_request"; param: string; message: string } };

const OPERATORS: RangeOperator[] = ["gte", "gt", "lte", "lt"];
const TYPES: RangeType[] = ["integer", "number", "date", "date-time"];
const NUMBER = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const TIMESTAMP = /^([0-9]{4}-[0-9]{2}-[0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?([Zz]|[+-][0-9]{2}:[0-9]{2})$/;
const FILTER = /^filter\[([^\[\].]+)\]\[([^\[\]]+)\]$/;
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isType(value: unknown): value is RangeType { return TYPES.includes(value as RangeType); }
function isOp(value: unknown): value is RangeOperator { return OPERATORS.includes(value as RangeOperator); }

export function clientRangeFiltersRsCapability() {
	return { supported: true, stability: "experimental", profile: CLIENT_RANGE_FILTERS_PROFILE_URI } as const;
}

export function parseFrozenFilterSet(
	extensions: unknown,
	streamGrants: Array<{ name: string; fields?: string[] | null | undefined }>,
): FrozenFilterSet {
	if (extensions === undefined || (object(extensions) && !Object.hasOwn(extensions, CLIENT_RANGE_FILTERS_PROFILE_URI))) return { kind: "absent" };
	const malformed = (): FrozenFilterSet => ({ kind: "malformed", reason: "Malformed client range filters frozen set" });
	if (!object(extensions)) return malformed();
	const profile = extensions[CLIENT_RANGE_FILTERS_PROFILE_URI];
	if (!object(profile) || !object(profile.streams) || Object.keys(profile.streams).length === 0) return malformed();
	const streams = new Map<string, FrozenStream>();
	for (const [name, fields] of Object.entries(profile.streams)) {
		const grant = streamGrants.find(item => item.name === name);
		if (!grant || !object(fields) || Object.keys(fields).length === 0) return malformed();
		const frozen: FrozenStream = new Map();
		for (const [field, descriptor] of Object.entries(fields)) {
			// null/undefined fields mean membership is unavailable to this helper;
			// descriptor validity remains mandatory, with no inferred wildcard.
			if (grant.fields != null && !grant.fields.includes(field)) return malformed();
			if (!object(descriptor) || !isType(descriptor.type) || !Array.isArray(descriptor.ops) || descriptor.ops.length === 0) return malformed();
			const ops = new Set<RangeOperator>();
			for (const op of descriptor.ops) {
				if (!isOp(op) || ops.has(op)) return malformed();
				ops.add(op);
			}
			frozen.set(field, { type: descriptor.type, ops });
		}
		streams.set(name, frozen);
	}
	return { kind: "ok", streams };
}

function decimal(coefficient: bigint, exponent: bigint): ExactDecimal {
	if (coefficient === 0n) return { kind: "decimal", coefficient: 0n, exponent: 0n };
	while (coefficient % 10n === 0n) { coefficient /= 10n; exponent++; }
	return { kind: "decimal", coefficient, exponent };
}

// An adapter that retains JSON number lexemes may supply this result for stored
// numbers. Bare strings remain JSON strings and MUST fail numeric predicates.
export function parseClientRangeDecimal(text: string): ExactDecimal | null {
	const match = NUMBER.exec(text);
	if (!match || match[0] !== text) return null;
	const [, sign, whole, fraction = "", power = "0"] = match;
	return decimal(BigInt(sign! + whole! + fraction), BigInt(power) - BigInt(fraction.length));
}

// Compare magnitudes without 10 ** exponent: huge exponent lexemes must not
// cause unbounded zero allocation. Padding is bounded by coefficient length.
function compare(a: ExactDecimal, b: ExactDecimal): number {
	if (a.coefficient === b.coefficient && a.exponent === b.exponent) return 0;
	const signA = a.coefficient < 0n ? -1 : a.coefficient === 0n ? 0 : 1;
	const signB = b.coefficient < 0n ? -1 : b.coefficient === 0n ? 0 : 1;
	if (signA !== signB) return signA < signB ? -1 : 1;
	if (signA === 0) return 0;
	const x = (a.coefficient < 0n ? -a.coefficient : a.coefficient).toString();
	const y = (b.coefficient < 0n ? -b.coefficient : b.coefficient).toString();
	const magnitudeA = BigInt(x.length) + a.exponent;
	const magnitudeB = BigInt(y.length) + b.exponent;
	if (magnitudeA !== magnitudeB) return (magnitudeA < magnitudeB ? -1 : 1) * signA;
	const length = Math.max(x.length, y.length);
	const left = x.padEnd(length, "0"), right = y.padEnd(length, "0");
	return (left === right ? 0 : left < right ? -1 : 1) * signA;
}

function dateSeconds(text: string): bigint | null {
	const match = DATE.exec(text);
	if (!match || match[0] !== text) return null;
	const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (month < 1 || month > 12 || day < 1 || day > lengths[month - 1]!) return null;
	// setUTCFullYear avoids Date.UTC's special interpretation of years 00..99.
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	return BigInt(date.getTime() / 1000);
}

// UTC days that ended with an inserted leap second (IERS bulletin C, 27 entries
// through 2016-12-31). Core "Time constraint semantics" accepts :60 only on
// these days. Extend when the IERS announces a new one.
const LEAP_SECOND_DAYS = [
	"1972-06-30", "1972-12-31", "1973-12-31", "1974-12-31", "1975-12-31", "1976-12-31",
	"1977-12-31", "1978-12-31", "1979-12-31", "1981-06-30", "1982-06-30", "1983-06-30",
	"1985-06-30", "1987-12-31", "1989-12-31", "1990-12-31", "1992-06-30", "1993-06-30",
	"1994-06-30", "1995-12-31", "1997-06-30", "1998-12-31", "2005-12-31", "2008-12-31",
	"2012-06-30", "2015-06-30", "2016-12-31",
];
// POSIX seconds of the midnight that follows each leap second, ascending.
const LEAP_BOUNDARIES: bigint[] = LEAP_SECOND_DAYS.map((day) => dateSeconds(day)! + 86400n);

// Position on a timeline that counts inserted leap seconds, so 23:59:60 orders
// after :59 and before the next minute while equal instants stay equal.
function leapCount(posixSeconds: bigint, inclusive: boolean): bigint {
	let count = 0n;
	for (const boundary of LEAP_BOUNDARIES) {
		if (inclusive ? boundary <= posixSeconds : boundary < posixSeconds) count += 1n;
	}
	return count;
}

function parseValue(text: string, type: RangeType): ParsedValue | null {
	if (type === "number" || type === "integer") {
		const value = parseClientRangeDecimal(text);
		return value && (type !== "integer" || value.exponent >= 0n) ? value : null;
	}
	if (type === "date") {
		const seconds = dateSeconds(text);
		return seconds === null ? null : decimal(seconds, 0n);
	}
	const match = TIMESTAMP.exec(text);
	if (!match || match[0] !== text) return null;
	const [, day, hours, minutes, seconds, fraction = "", zone] = match;
	const midnight = dateSeconds(day!);
	const hour = Number(hours), minute = Number(minutes), second = Number(seconds);
	if (midnight === null || hour > 23 || minute > 59 || second > 60) return null;
	let offset = 0;
	if (zone!.toUpperCase() !== "Z") {
		const offsetHour = Number(zone!.slice(1, 3)), offsetMinute = Number(zone!.slice(4, 6));
		if (offsetHour > 23 || offsetMinute > 59) return null;
		offset = (offsetHour * 60 + offsetMinute) * 60 * (zone![0] === "-" ? -1 : 1);
	}
	const posix = midnight + BigInt(hour * 3600 + minute * 60 + second - offset);
	let whole: bigint;
	if (second === 60) {
		// Valid only as 23:59:60 UTC on an inserted-leap-second day: the posix
		// value then equals the following midnight, a known boundary.
		if (!LEAP_BOUNDARIES.includes(posix)) return null;
		whole = posix + leapCount(posix, false);
	} else {
		whole = posix + leapCount(posix, true);
	}
	// Exact seconds with arbitrary decimal fraction; nanoseconds and finer are
	// retained rather than truncated to Date's milliseconds.
	const scale = 10n ** BigInt(fraction.length);
	return decimal(whole * scale + BigInt(fraction || "0"), -BigInt(fraction.length));
}

function invalid(param: string): CompileResult {
	// Deliberately depends only on submitted syntax, never field classification.
	return { ok: false, error: { status: 400, code: "invalid_request", param, message: "Invalid client range filter: " + param } };
}
export function compileClientRangeFilters(pairs: Array<[string, string]>, frozenStream: FrozenStream | undefined): CompileResult {
	const filters: ClientRangeFilter[] = [];
	const seen = new Set<string>();
	for (const [name, text] of pairs) {
		if (!name.startsWith("filter")) continue;
		if (!frozenStream) return invalid(name);
		const match = FILTER.exec(name);
		if (!match || match[0] !== name) return invalid(name);
		const field = match[1]!, op = match[2]!;
		const descriptor = frozenStream.get(field);
		if (!descriptor || !isOp(op) || !descriptor.ops.has(op)) return invalid(name);
		const key = JSON.stringify([field, op]);
		if (seen.has(key)) return invalid(name);
		seen.add(key);
		const value = parseValue(text, descriptor.type);
		if (value === null) return invalid(name);
		filters.push({ field, op, type: descriptor.type, value, decodedValue: text });
	}
	return { ok: true, filters };
}

export function matchesClientRangeFilters(storedRecordData: unknown, filters: ClientRangeFilter[]): boolean {
	return filters.every(filter => {
		if (!object(storedRecordData) || !Object.hasOwn(storedRecordData, filter.field)) return false;
		const raw = storedRecordData[filter.field];
		let value: ParsedValue | null = null;
		if (filter.type === "number" || filter.type === "integer") {
			if (typeof raw === "number" && Number.isFinite(raw)) value = parseValue(String(raw), filter.type);
			else if (object(raw) && raw.kind === "decimal" && typeof raw.coefficient === "bigint" && typeof raw.exponent === "bigint") {
				value = decimal(raw.coefficient, raw.exponent);
				if (filter.type === "integer" && value.exponent < 0n) value = null;
			}
		} else if (typeof raw === "string") value = parseValue(raw, filter.type);
		if (value === null) return false;
		const order = compare(value, filter.value);
		switch (filter.op) {
			case "gte": return order >= 0;
			case "gt": return order > 0;
			case "lte": return order <= 0;
			case "lt": return order < 0;
		}
	});
}

export function clientFilterSetKey(filters: ClientRangeFilter[]): string {
	// JSON tuple encoding avoids separator collisions; sorting ignores pair
	// order. Keep 1, 1.0 and 1e0 distinct as decoded Section 6.7 value strings.
	return JSON.stringify([...new Set(filters.map(filter => JSON.stringify([filter.field, filter.op, filter.decodedValue])))].sort());
}

export function frozenStreamMetadata(frozenStream: FrozenStream | undefined): {
	range_filters: Record<string, string[]>;
	range_filter_types: Record<string, RangeType>;
} {
	const entries = [...(frozenStream ?? new Map<string, FrozenDescriptor>())];
	return {
		range_filters: Object.fromEntries(entries.map(([field, descriptor]) => [field, OPERATORS.filter(op => descriptor.ops.has(op))])),
		range_filter_types: Object.fromEntries(entries.map(([field, descriptor]) => [field, descriptor.type])),
	};
}

// Decode stored record text with each top-level number kept as an exact decimal,
// the form matchesClientRangeFilters compares without binary64 rounding. Only
// top-level members are filter operands, so nested values are not decoded.
export function exactStoredRecord(text: string): Record<string, unknown> {
	return parseTopLevelWithNumbers(text, (lexeme) => parseClientRangeDecimal(lexeme) ?? Number(lexeme));
}

// Section 2: a client treats the RS as supporting the profile if and only if
// capabilities.client_range_filters is an object that meets all three tests.
export function rsAdvertisesClientRangeFilters(metadata: unknown): boolean {
	const capabilities = object(metadata) ? metadata.capabilities : undefined;
	const entry = object(capabilities) ? capabilities.client_range_filters : undefined;
	return object(entry) && entry.supported === true && entry.stability === "experimental" && entry.profile === CLIENT_RANGE_FILTERS_PROFILE_URI;
}

// Section 2: exact string membership; unknown entries are ignored.
export function asAdvertisesClientRangeFilters(metadata: unknown): boolean {
	const supported = object(metadata) ? metadata.pdpp_client_range_filters_supported : undefined;
	return Array.isArray(supported) && supported.includes(CLIENT_RANGE_FILTERS_PROFILE_URI);
}
