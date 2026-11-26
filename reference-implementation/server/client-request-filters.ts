// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { FilterField } from "@pdpp/reference-contract/public/source";

export type { FilterField } from "@pdpp/reference-contract/public/source";
export interface ClientFilter {
  field: string;
  kind: "client";
  operator: string | null;
  type: FilterField["type"];
  value: string;
}

type Pair = readonly [string, string];
const requestEntries = new WeakMap<object, Pair[]>();
const numberSources = new WeakMap<object, Map<string, string>>();
const FILTER_NAME = /^filter\[([^[\]]+)\](?:\[([^[\]]+)\])?$/;
const NUMBER = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const LEADING_ZEROES = /^0+/;
const TRAILING_ZEROES = /0+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4}-\d{2}-\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([zZ]|[+-]\d{2}:\d{2})$/;
// IERS Bulletin C: dates on which a positive UTC leap second was inserted.
const LEAP_DAYS = new Set([
  "1972-06-30",
  "1972-12-31",
  "1973-12-31",
  "1974-12-31",
  "1975-12-31",
  "1976-12-31",
  "1977-12-31",
  "1978-12-31",
  "1979-12-31",
  "1981-06-30",
  "1982-06-30",
  "1983-06-30",
  "1985-06-30",
  "1987-12-31",
  "1989-12-31",
  "1990-12-31",
  "1992-06-30",
  "1993-06-30",
  "1994-06-30",
  "1995-12-31",
  "1997-06-30",
  "1998-12-31",
  "2005-12-31",
  "2008-12-31",
  "2012-06-30",
  "2015-06-30",
  "2016-12-31",
]);
const LEAP_BOUNDARIES = [...LEAP_DAYS].map((day) => Date.parse(`${day}T23:59:59Z`));

function error(param: string, message: string, code = "invalid_request") {
  return Object.assign(new Error(message), { code, param });
}

/** Preserve decoded pair order and duplicates before qs merges bracket keys. */
export function retainClientFilterEntries<T extends object>(query: T, rawQuery: string): T {
  const entries = [...new URLSearchParams(rawQuery)].filter(([name]) => name.startsWith("filter["));
  let filter: unknown = Reflect.get(query, "filter");
  // qs drops prototype-named keys. Authorize them instead of silently
  // dropping a requested filter from the read.
  if (filter === undefined && entries.length) {
    filter = {};
    Reflect.set(query, "filter", filter);
  }
  if (filter && typeof filter === "object") {
    requestEntries.set(filter, entries);
  }
  return query;
}

export function clientFilterEntries(filter: unknown): Pair[] {
  if (filter === undefined || filter === null) {
    return [];
  }
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw error("filter", "filter must use filter[field]=value or filter[field][op]=value");
  }
  const retained = requestEntries.get(filter);
  if (retained) {
    return retained;
  }
  return Object.entries(filter).flatMap(([field, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value).flatMap(([op, operand]) =>
        (Array.isArray(operand) ? operand : [operand]).map((item) => [`filter[${field}][${op}]`, String(item)] as Pair)
      );
    }
    return (Array.isArray(value) ? value : [value]).map((item) => [`filter[${field}]`, String(item)] as Pair);
  });
}

/** Used by cursor contexts: decoded spelling matters, request order does not. */
export function clientFilterBinding(filter: unknown): Pair[] {
  return clientFilterEntries(filter).toSorted(([an, av], [bn, bv]) => {
    if (an !== bn) {
      return an < bn ? -1 : 1;
    }
    return av < bv ? -1 : Number(av > bv);
  });
}

export function parseClientFilterParameters(filter: unknown) {
  return clientFilterEntries(filter).map(([name, value]) => {
    const match = FILTER_NAME.exec(name);
    if (!match) {
      throw error(name, "Invalid filter syntax");
    }
    return { field: match[1] as string, name, operator: match[2] ?? null, value };
  });
}

interface Decimal {
  digits: string;
  exponent: bigint;
  negative: boolean;
}
function decimal(value: string): Decimal | null {
  const match = NUMBER.exec(value);
  if (!match) {
    return null;
  }
  const [, sign, whole = "", fraction = "", exp = "0"] = match;
  let digits = (whole + fraction).replace(LEADING_ZEROES, "");
  if (!digits) {
    return { digits: "0", exponent: BigInt(0), negative: false };
  }
  let exponent = BigInt(exp) - BigInt(fraction.length);
  const trimmed = digits.replace(TRAILING_ZEROES, "");
  exponent += BigInt(digits.length - trimmed.length);
  digits = trimmed;
  return { digits, exponent, negative: sign === "-" };
}

function compareDecimal(a: Decimal, b: Decimal): number {
  if (a.digits === "0" && b.digits === "0") {
    return 0;
  }
  if (a.negative !== b.negative) {
    return a.negative ? -1 : 1;
  }
  let comparison: number;
  if (a.digits === "0" || b.digits === "0") {
    comparison = a.digits === "0" ? -1 : 1;
  } else {
    const aSize = BigInt(a.digits.length) + a.exponent;
    const bSize = BigInt(b.digits.length) + b.exponent;
    if (aSize === bSize) {
      const size = Math.max(a.digits.length, b.digits.length);
      const left = a.digits.padEnd(size, "0");
      const right = b.digits.padEnd(size, "0");
      comparison = left < right ? -1 : Number(left > right);
    } else {
      comparison = aSize < bSize ? -1 : 1;
    }
  }
  return a.negative ? -comparison : comparison;
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function instant(value: string): Decimal | null {
  const match = INSTANT.exec(value);
  if (!match) {
    return null;
  }
  const [, day = "", hour = "", minute = "", second = "", fraction = "", zone = ""] = match;
  if (!validDate(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) {
    return null;
  }
  if (zone.length > 1 && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) {
    return null;
  }
  const leap = second === "60";
  const milliseconds = Date.parse(`${day}T${hour}:${minute}:${leap ? "59" : second}${zone.toUpperCase()}`);
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  const utc = new Date(milliseconds).toISOString();
  if (leap && !(utc.slice(11, 19) === "23:59:59" && LEAP_DAYS.has(utc.slice(0, 10)))) {
    return null;
  }
  const priorLeaps = LEAP_BOUNDARIES.filter((boundary) => milliseconds > boundary).length;
  // Shift the epoch before year zero so fractional seconds have a positive coefficient.
  const seconds = BigInt(milliseconds / 1000) + BigInt(62_167_219_200) + BigInt(priorLeaps) + BigInt(leap);
  return decimal(`${seconds}.${fraction || "0"}`);
}

function validValue(type: FilterField["type"], value: string): boolean {
  if (type === "string") {
    return true;
  }
  if (type === "boolean") {
    return value === "true" || value === "false";
  }
  if (type === "date") {
    return validDate(value);
  }
  if (type === "date-time") {
    return instant(value) !== null;
  }
  const parsed = decimal(value);
  return parsed !== null && (type !== "integer" || parsed.exponent >= BigInt(0));
}

export function compileClientRequestFilters(
  filter: unknown,
  grant: {
    fields?: string[] | null;
    filter_fields?: Record<string, FilterField>;
  }
): ClientFilter[] {
  const entries = clientFilterEntries(filter);
  if (!entries.length) {
    return [];
  }
  if (!grant.filter_fields) {
    throw error("filter", "Client filters require frozen filter_fields");
  }
  const parsed = parseClientFilterParameters(filter);
  const denied = parsed.filter(({ field }) => !grant.fields?.includes(field));
  const [firstDenied] = denied;
  if (firstDenied) {
    throw error(
      firstDenied.name,
      `Fields not in grant: ${[...new Set(denied.map(({ field }) => field))].join(", ")}`,
      "field_not_granted"
    );
  }
  const seen = new Set<string>();
  return parsed.map(({ field, operator, name, value }) => {
    const capability =
      grant.filter_fields && Object.hasOwn(grant.filter_fields, field) ? grant.filter_fields[field] : undefined;
    const pair = JSON.stringify([field, operator]);
    if (
      !capability ||
      (operator !== null && !capability.range.includes(operator as FilterField["range"][number])) ||
      seen.has(pair)
    ) {
      throw error(name, `Unsupported or repeated filter on '${field}'`);
    }
    seen.add(pair);
    if (!validValue(capability.type, value)) {
      throw error(name, `Invalid ${capability.type} filter value for '${field}'`);
    }
    return { field, kind: "client", operator, type: capability.type, value };
  });
}

/** Keep JSON numbers as numbers for response compatibility, with their original lexemes for comparisons. */
export function parseFilterRecordJson(text: string): Record<string, unknown> {
  return JSON.parse(text, function (this: object, key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === "number" && context?.source) {
      let sources = numberSources.get(this);
      if (!sources) {
        sources = new Map();
        numberSources.set(this, sources);
      }
      sources.set(key, context.source);
    }
    return value;
  });
}

export function passesClientFilter(data: Record<string, unknown> | null, filter: ClientFilter): boolean {
  if (!data) {
    return false;
  }
  const stored = data?.[filter.field];
  let expectedType = "string";
  if (filter.type === "integer" || filter.type === "number") {
    expectedType = "number";
  }
  if (filter.type === "boolean") {
    expectedType = "boolean";
  }
  if (typeof stored !== expectedType || stored === null) {
    return false;
  }
  const value =
    typeof stored === "number" ? (numberSources.get(data)?.get(filter.field) ?? String(stored)) : String(stored);
  if (!validValue(filter.type, value)) {
    return false;
  }
  let comparison: number;
  if (filter.type === "number" || filter.type === "integer" || filter.type === "date-time") {
    const parse = filter.type === "date-time" ? instant : decimal;
    const left = parse(value);
    const right = parse(filter.value);
    if (!(left && right)) {
      return false;
    }
    comparison = compareDecimal(left, right);
  } else {
    comparison = value < filter.value ? -1 : Number(value > filter.value);
  }
  switch (filter.operator) {
    case null:
      return comparison === 0;
    case "gte":
      return comparison >= 0;
    case "gt":
      return comparison > 0;
    case "lte":
      return comparison <= 0;
    case "lt":
      return comparison < 0;
    default:
      return false;
  }
}
