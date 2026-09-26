import assert from "node:assert/strict";
import test from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { makeEmitRecord } from "../../polyfill-connectors/src/connector-runtime.ts";

function selected(
  timeRange: { since?: string; until?: string },
  value: unknown,
): boolean {
  const emitted: EmittedMessage[] = [];
  const gate = makeEmitRecord({
    requested: new Map([["events", { time_range: timeRange }]]),
    emit: async (message) => {
      emitted.push(message);
    },
    emittedAt: "2026-05-03T00:00:00.000Z",
    validateRecord: undefined,
    isTombstone: undefined,
    timeRangeFieldFor: () => "occurred_at",
  });

  void gate.emit("events", { id: "event-1", occurred_at: value });
  return gate.counters.totalEmitted === 1;
}

test("vendored connector runtime applies exact half-open timestamp bounds", () => {
  assert.equal(
    selected({ since: "2026-05-02T23:59:59Z" }, "2026-05-02T00:00:01Z"),
    false,
  );
  assert.equal(
    selected({ since: "2026-05-02T23:59:59Z" }, "2026-05-02T23:59:59Z"),
    true,
  );
  assert.equal(
    selected({ until: "2026-05-03T00:00:01Z" }, "2026-05-02T23:59:59Z"),
    true,
  );
  assert.equal(
    selected({ until: "2026-05-03T00:00:01Z" }, "2026-05-03T00:00:01Z"),
    false,
  );
});

test("vendored connector runtime compares offset timestamps by instant", () => {
  assert.equal(
    selected({ since: "2026-05-03T05:30:00+05:30" }, "2026-05-02T23:59:59Z"),
    false,
  );
  assert.equal(
    selected({ since: "2026-05-03T05:30:00+05:30" }, "2026-05-03T00:00:00Z"),
    true,
  );
  assert.equal(
    selected({ until: "2026-05-02T17:00:00-07:00" }, "2026-05-02T23:59:59Z"),
    true,
  );
  assert.equal(
    selected({ until: "2026-05-02T17:00:00-07:00" }, "2026-05-03T00:00:00Z"),
    false,
  );
});

test("vendored connector runtime treats date-only values as UTC-day intervals", () => {
  assert.equal(
    selected({ since: "2026-05-02T12:00:00Z" }, "2026-05-02"),
    true,
  );
  assert.equal(
    selected({ since: "2026-05-03T00:00:00Z" }, "2026-05-02"),
    false,
  );
  assert.equal(
    selected({ until: "2026-05-02T12:00:00Z" }, "2026-05-02"),
    true,
  );
  assert.equal(
    selected({ until: "2026-05-02T00:00:00Z" }, "2026-05-02"),
    false,
  );
});
