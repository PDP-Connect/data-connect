import assert from "node:assert/strict";
import test from "node:test";
import { makeEmitGate, passesTimeRange } from "./scope-filters.ts";

test("passesTimeRange compares offset timestamps as instants", () => {
  assert.equal(
    passesTimeRange("2026-05-02T23:59:59Z", {
      since: "2026-05-03T05:30:00+05:30",
    }),
    false
  );
  assert.equal(
    passesTimeRange("2026-05-03T00:00:00Z", {
      since: "2026-05-03T05:30:00+05:30",
    }),
    true
  );
  assert.equal(
    passesTimeRange("2026-05-02T23:59:59Z", {
      until: "2026-05-02T17:00:00-07:00",
    }),
    true
  );
  assert.equal(
    passesTimeRange("2026-05-03T00:00:00Z", {
      until: "2026-05-02T17:00:00-07:00",
    }),
    false
  );
});

test("passesTimeRange rejects date-only values as invalid consent timestamps", () => {
  assert.equal(passesTimeRange("2026-05-02", { since: "2026-05-02T12:00:00Z" }), false);
  assert.equal(passesTimeRange("2026-05-02", { until: "2026-05-02T00:00:00Z" }), false);
});

test("passesTimeRange rejects empty and reversed ranges", () => {
  assert.equal(
    passesTimeRange("2026-05-02T12:00:00Z", {
      since: "2026-05-02T12:00:00Z",
      until: "2026-05-02T12:00:00Z",
    }),
    false
  );
  assert.equal(
    passesTimeRange("2026-05-02T12:00:00Z", {
      since: "2026-05-02T13:00:00Z",
      until: "2026-05-02T12:00:00Z",
    }),
    false
  );
});

test("passesTimeRange preserves fractional-second precision", () => {
  assert.equal(passesTimeRange("2026-05-02T12:00:00.1234Z", { since: "2026-05-02T12:00:00.1235Z" }), false);
  assert.equal(passesTimeRange("2026-05-02T12:00:00.1234Z", { until: "2026-05-02T12:00:00.1235Z" }), true);
  assert.equal(passesTimeRange("2026-05-02T12:00:00.1235Z", { until: "2026-05-02T12:00:00.1235Z" }), false);
});

test("makeEmitGate fails closed on invalid timestamps and bounds", () => {
  let emitted = 0;
  const gate = makeEmitGate(
    () => {
      emitted += 1;
    },
    {
      time_range: { since: "2026-05-02T00:00:00Z" },
    },
    { consentTimeField: "occurred_at" }
  );

  for (const value of [undefined, null, "", 42, "May 2, 2026", "2026-02-30T12:00:00Z"]) {
    assert.equal(gate("events", { id: String(value), occurred_at: value }), false, String(value));
  }
  assert.equal(emitted, 0);

  const invalidBoundGate = makeEmitGate(
    () => {
      emitted += 1;
    },
    {
      time_range: { since: "2026-02-30T00:00:00Z" },
    },
    { consentTimeField: "occurred_at" }
  );
  assert.equal(invalidBoundGate("events", { id: "valid", occurred_at: "2026-05-02T00:00:00Z" }), false);
  const invalidUntilGate = makeEmitGate(
    () => {
      emitted += 1;
    },
    {
      time_range: { until: "not-an-ISO-timestamp" },
    },
    { consentTimeField: "occurred_at" }
  );
  assert.equal(invalidUntilGate("events", { id: "valid", occurred_at: "2026-05-02T00:00:00Z" }), false);
  assert.equal(emitted, 0);

  for (const time_range of [
    { since: "2026-05-02T12:00:00Z", until: "2026-05-02T12:00:00Z" },
    { since: "2026-05-02T13:00:00Z", until: "2026-05-02T12:00:00Z" },
  ]) {
    const emptyRangeGate = makeEmitGate(
      () => {
        emitted += 1;
      },
      { time_range },
      {
        consentTimeField: "occurred_at",
      }
    );
    assert.equal(emptyRangeGate("events", { id: "empty", occurred_at: "2026-05-02T12:30:00Z" }), false);
  }
  assert.equal(emitted, 0);
});
