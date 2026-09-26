import assert from "node:assert/strict";
import test from "node:test";
import { passesTimeRange } from "./scope-filters.ts";

test("passesTimeRange compares offset timestamps as instants", () => {
  assert.equal(
    passesTimeRange("2026-05-02T23:59:59Z", {
      since: "2026-05-03T05:30:00+05:30",
    }),
    false,
  );
  assert.equal(
    passesTimeRange("2026-05-03T00:00:00Z", {
      since: "2026-05-03T05:30:00+05:30",
    }),
    true,
  );
  assert.equal(
    passesTimeRange("2026-05-02T23:59:59Z", {
      until: "2026-05-02T17:00:00-07:00",
    }),
    true,
  );
  assert.equal(
    passesTimeRange("2026-05-03T00:00:00Z", {
      until: "2026-05-02T17:00:00-07:00",
    }),
    false,
  );
});

test("passesTimeRange treats date-only values as UTC-day intervals", () => {
  assert.equal(
    passesTimeRange("2026-05-02", { since: "2026-05-02T12:00:00Z" }),
    true,
  );
  assert.equal(
    passesTimeRange("2026-05-02", { until: "2026-05-02T00:00:00Z" }),
    false,
  );
});
