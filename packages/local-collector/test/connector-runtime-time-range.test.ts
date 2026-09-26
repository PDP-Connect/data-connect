// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

async function emittedTombstone(
  timeRange: { since?: string; until?: string },
  value: unknown,
): Promise<EmittedMessage[]> {
  const emitted: EmittedMessage[] = [];
  const gate = makeEmitRecord({
    requested: new Map([["events", { time_range: timeRange }]]),
    emit: async (message) => {
      emitted.push(message);
    },
    emittedAt: "2026-05-03T00:00:00.000Z",
    validateRecord: undefined,
    isTombstone: () => true,
    timeRangeFieldFor: () => "occurred_at",
  });
  await gate.emit("events", { id: "event-1", occurred_at: value });
  return emitted;
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

test("vendored connector runtime preserves fractional-second precision", () => {
  assert.equal(
    selected({ since: "2026-05-02T12:00:00.1235Z" }, "2026-05-02T12:00:00.1234Z"),
    false,
  );
  assert.equal(
    selected({ until: "2026-05-02T12:00:00.1235Z" }, "2026-05-02T12:00:00.1234Z"),
    true,
  );
});

test("vendored connector runtime rejects date-only consent timestamps", () => {
  assert.equal(
    selected({ since: "2026-05-02T12:00:00Z" }, "2026-05-02"),
    false,
  );
  assert.equal(
    selected({ since: "2026-05-03T00:00:00Z" }, "2026-05-02"),
    false,
  );
  assert.equal(
    selected({ until: "2026-05-02T00:00:00Z" }, "2026-05-02"),
    false,
  );
});

test("vendored connector runtime rejects invalid bounds and consent timestamps before emission", () => {
  for (const value of [undefined, null, "", 42, "May 2, 2026", "2026-02-30T12:00:00Z"]) {
    assert.equal(selected({ since: "2026-05-02T00:00:00Z" }, value), false, String(value));
  }
  assert.equal(selected({ since: "2026-02-30T00:00:00Z" }, "2026-05-02T00:00:00Z"), false);
  assert.equal(selected({ until: "not-an-ISO-timestamp" }, "2026-05-02T00:00:00Z"), false);
  assert.equal(selected({
    since: "2026-05-02T12:00:00Z",
    until: "2026-05-02T12:00:00Z",
  }, "2026-05-02T12:00:00Z"), false);
  assert.equal(selected({
    since: "2026-05-02T13:00:00Z",
    until: "2026-05-02T12:00:00Z",
  }, "2026-05-02T12:30:00Z"), false);
});

test("vendored connector runtime applies time_range before emitting tombstones", async () => {
  assert.equal((await emittedTombstone({ since: "2026-05-02T00:00:00Z" }, undefined)).length, 0);
  assert.equal((await emittedTombstone({ since: "2026-05-02T00:00:00Z" }, "2026-05-01T23:59:59Z")).length, 0);
  assert.equal((await emittedTombstone({ since: "2026-02-30T00:00:00Z" }, "2026-05-02T00:00:00Z")).length, 0);
  const inRange = await emittedTombstone({ since: "2026-05-02T00:00:00Z" }, "2026-05-02T00:00:00Z");
  assert.equal(inRange.length, 1);
  assert.equal(inRange[0]?.type === "RECORD" && inRange[0].op, "delete");
});
