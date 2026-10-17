// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalOwnerWindowSince,
  consentTimeFormat,
  describeReceivedSince,
  isDeclarableOwnerWindowSince,
  ownerWindowTimeRange,
  parseOwnerWindowSince,
} from "./owner-time-window.ts";

function stream(field: Record<string, unknown> | undefined, consentTimeField: string | null = "occurred") {
  return {
    consent_time_field: consentTimeField,
    schema: { properties: field ? { occurred: field } : {} },
  };
}

function since(value: string) {
  const parsed = parseOwnerWindowSince(value);
  assert.ok(parsed, `${value} must parse`);
  return parsed;
}

const DATE = { format: "date", type: "string" };
const DATE_TIME = { format: "date-time", type: ["string", "null"] };

test("an instant goes unchanged to a date-time field and as its own calendar day to a date field", () => {
  const owner = since("2026-09-05T00:00:00-04:00");
  assert.deepEqual(ownerWindowTimeRange(stream(DATE_TIME), owner), { since: "2026-09-05T00:00:00-04:00" });
  assert.deepEqual(ownerWindowTimeRange(stream(DATE), owner), { since: "2026-09-05" });
});

test("the date part is taken at the owner's offset, not in UTC", () => {
  // 23:30 on 5 Sep in UTC-4 is 03:30 on 6 Sep in UTC. A date field must get 5 Sep.
  assert.deepEqual(ownerWindowTimeRange(stream(DATE), since("2026-09-05T23:30:00-04:00")), { since: "2026-09-05" });
  assert.deepEqual(ownerWindowTimeRange(stream(DATE), since("2026-09-05T00:30:00+09:00")), { since: "2026-09-05" });
});

test("a stored full-date goes unchanged to a date field and as the day's earliest instant to a date-time field", () => {
  const owner = since("2026-09-05");
  assert.deepEqual(ownerWindowTimeRange(stream(DATE), owner), { since: "2026-09-05" });
  assert.deepEqual(ownerWindowTimeRange(stream(DATE_TIME), owner), { since: "2026-09-05T00:00:00+14:00" });
});

test("a field with no date or date-time format, or no consent field, gets no bound", () => {
  const owner = since("2026-09-05T00:00:00Z");
  assert.equal(ownerWindowTimeRange(stream({ type: "integer" }), owner), null);
  assert.equal(ownerWindowTimeRange(stream({ type: "string" }), owner), null);
  assert.equal(ownerWindowTimeRange(stream({ format: "date", type: "integer" }), owner), null);
  assert.equal(ownerWindowTimeRange(stream(undefined), owner), null);
  assert.equal(ownerWindowTimeRange(stream(DATE, null), owner), null);
  assert.equal(consentTimeFormat(undefined), null);
});

test("a stored date-time with no offset is read at its earliest instant, +14:00", () => {
  const owner = since("2026-09-05T08:30:00.25");
  assert.equal(owner.kind, "local_date_time");
  assert.deepEqual(ownerWindowTimeRange(stream(DATE_TIME), owner), { since: "2026-09-05T08:30:00.25+14:00" });
  assert.deepEqual(ownerWindowTimeRange(stream(DATE), owner), { since: "2026-09-05" });
});

test("canonicalization rewrites legacy values to the instant the runtime already uses", () => {
  assert.equal(canonicalOwnerWindowSince("2026-09-05"), "2026-09-05T00:00:00+14:00");
  assert.equal(canonicalOwnerWindowSince("2026-09-05T08:30:00"), "2026-09-05T08:30:00+14:00");
  assert.equal(canonicalOwnerWindowSince("2026-09-05T08:30:00-04:00"), "2026-09-05T08:30:00-04:00");
  // Unreadable values are left for the caller; the runtime sends no bound for them.
  assert.equal(canonicalOwnerWindowSince("Sep 5 2026"), "Sep 5 2026");
  // The canonical form renders to the same bounds as the legacy value.
  for (const legacy of ["2026-09-05", "2026-09-05T08:30:00"]) {
    for (const field of [DATE, DATE_TIME]) {
      assert.deepEqual(
        ownerWindowTimeRange(stream(field), since(canonicalOwnerWindowSince(legacy))),
        ownerWindowTimeRange(stream(field), since(legacy))
      );
    }
  }
});

test("an owner may declare only an RFC 3339 date-time with an offset", () => {
  assert.equal(isDeclarableOwnerWindowSince("2026-09-05T00:00:00-04:00"), true);
  assert.equal(isDeclarableOwnerWindowSince("2026-09-05t00:00:00.123456z"), true);
  assert.equal(isDeclarableOwnerWindowSince("2026-09-05"), false);
  assert.equal(isDeclarableOwnerWindowSince("2026-09-05T00:00:00"), false);
});

test("values that are not RFC 3339 do not parse", () => {
  for (const value of [
    "2026-09-05 00:00:00Z",
    "Sep 5 2026",
    "2026-02-30",
    "2026-09-05T24:00:00Z",
    "2026-09-05T00:00:00+24:00",
    "",
    "1757044800",
  ]) {
    assert.equal(parseOwnerWindowSince(value), null, value);
  }
  assert.equal(parseOwnerWindowSince(1_757_044_800), null);
  assert.ok(parseOwnerWindowSince("2028-02-29"));
});

test("describeReceivedSince never coerces a non-string value", () => {
  assert.equal(describeReceivedSince("2026-09-05"), "2026-09-05");
  assert.equal(describeReceivedSince({ toString: null }), "a value of type object");
  assert.equal(describeReceivedSince(42), "a value of type number");
  assert.equal(describeReceivedSince(["x"]), "a value of type array");
});
