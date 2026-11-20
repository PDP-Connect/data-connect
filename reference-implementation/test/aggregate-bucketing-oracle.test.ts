// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for the aggregate time-bucketing math
// (server/records.ts) that underpins the MCP `aggregate` read-model
// contract. bucketStartForGranularity and resolveAggregateTimeZone are pure but
// have ZERO by-name coverage — the existing aggregate tests exercise them only
// through the DB-backed aggregateRecords path and never assert the calendar-
// truncation boundaries (week-snap-to-Monday, quarter-start month, month/year
// truncation), the zone-aware day shift, or the null/unparseable/unknown-
// granularity routing. Pure, no DB.

import assert from "node:assert/strict";
import test from "node:test";
import { bucketStartForGranularity, resolveAggregateTimeZone } from "../server/records.ts";

const T = "2026-07-02T15:37:42Z"; // a Thursday, mid-afternoon UTC

test("bucketStartForGranularity truncates to minute/hour/day in UTC", () => {
  assert.equal(bucketStartForGranularity(T, "minute", "UTC"), "2026-07-02T15:37:00+00:00");
  assert.equal(bucketStartForGranularity(T, "hour", "UTC"), "2026-07-02T15:00:00+00:00");
  assert.equal(bucketStartForGranularity(T, "day", "UTC"), "2026-07-02");
});

test("bucketStartForGranularity snaps a week back to Monday", () => {
  // 2026-07-02 is a Thursday; the ISO week starts Monday 2026-06-29.
  assert.equal(bucketStartForGranularity("2026-07-02T00:00:00Z", "week", "UTC"), "2026-06-29");
  // A Monday snaps to itself.
  assert.equal(bucketStartForGranularity("2026-06-29T12:00:00Z", "week", "UTC"), "2026-06-29");
});

test("bucketStartForGranularity truncates month/quarter/year to their first day", () => {
  assert.equal(bucketStartForGranularity(T, "month", "UTC"), "2026-07-01");
  assert.equal(bucketStartForGranularity(T, "year", "UTC"), "2026-01-01");
  // July is Q3 -> quarter start month is July.
  assert.equal(bucketStartForGranularity("2026-08-15T00:00:00Z", "quarter", "UTC"), "2026-07-01");
  // February is Q1 -> quarter start month is January.
  assert.equal(bucketStartForGranularity("2026-02-15T00:00:00Z", "quarter", "UTC"), "2026-01-01");
});

test("bucketStartForGranularity buckets by the zone wall-clock, not UTC", () => {
  // 2026-07-02T02:00Z is 2026-07-01 22:00 in America/New_York -> the prior day.
  assert.equal(bucketStartForGranularity("2026-07-02T02:00:00Z", "day", "America/New_York"), "2026-07-01");
});

test("bucketStartForGranularity qualifies hour/minute keys with the zone's UTC offset", () => {
  // 2026-07-02T15:37Z is 11:37 EDT (-04:00); the same wall-clock key in winter is -05:00.
  assert.equal(bucketStartForGranularity(T, "hour", "America/New_York"), "2026-07-02T11:00:00-04:00");
  assert.equal(
    bucketStartForGranularity("2026-01-02T15:37:42Z", "minute", "America/New_York"),
    "2026-01-02T10:37:00-05:00"
  );
  // Half-hour offsets keep their minutes.
  assert.equal(bucketStartForGranularity(T, "hour", "Asia/Kolkata"), "2026-07-02T21:00:00+05:30");
  // A DST fall-back repeats 01:00-01:59 local; the offset keeps the two hours apart.
  assert.equal(
    bucketStartForGranularity("2024-11-03T05:30:00Z", "hour", "America/New_York"),
    "2024-11-03T01:00:00-04:00"
  );
  assert.equal(
    bucketStartForGranularity("2024-11-03T06:30:00Z", "hour", "America/New_York"),
    "2024-11-03T01:00:00-05:00"
  );
  // Day keys stay date-only: a 25-hour day is one bucket.
  assert.equal(bucketStartForGranularity("2024-11-03T06:30:00Z", "day", "America/New_York"), "2024-11-03");
});

test("bucketStartForGranularity returns null for null, unparseable, and unknown granularity", () => {
  assert.equal(bucketStartForGranularity(null, "day", "UTC"), null);
  assert.equal(bucketStartForGranularity("not-a-date", "day", "UTC"), null);
  assert.equal(bucketStartForGranularity(T, "decade", "UTC"), null);
});

test("resolveAggregateTimeZone defaults falsy zones to UTC and passes a valid IANA zone through", () => {
  assert.equal(resolveAggregateTimeZone(null), "UTC");
  assert.equal(resolveAggregateTimeZone(undefined), "UTC");
  assert.equal(resolveAggregateTimeZone(""), "UTC");
  assert.equal(resolveAggregateTimeZone("America/New_York"), "America/New_York");
});

interface QueryError extends Error {
  code?: string;
}

function isQueryError(value: unknown): value is QueryError {
  return value instanceof Error;
}

test("resolveAggregateTimeZone rejects an unknown IANA zone with invalid_request", () => {
  assert.throws(
    () => resolveAggregateTimeZone("Mars/Phobos"),
    (err) => {
      assert.ok(isQueryError(err), "thrown value is an Error");
      assert.equal(err.code, "invalid_request");
      assert.ok(err.message.includes("Unknown time_zone: 'Mars/Phobos'"));
      return true;
    }
  );
});
