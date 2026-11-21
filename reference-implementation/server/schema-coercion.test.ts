// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { coerceComparableValue } from "./schema-coercion.ts";

const schema = (format: "date" | "date-time") => ({ type: ["string", "null"], format });

test("strict date coercion requires the declared syntax and a real calendar date", () => {
  for (const [format, input] of [
    ["date", "2024-04-01T00:05:00Z"],
    ["date-time", "2024-04-01"],
    ["date", "2023-02-29"],
    ["date-time", "2024-02-30T23:30:00-05:00"],
    ["date-time", "2024-03-01T00:00:00"],
    ["date-time", "2024-03-01T24:00:00Z"],
    ["date", "2024-04-01\n"],
  ] as const) {
    assert.throws(() => coerceComparableValue(input, schema(format), { strict: true }), /Invalid date value/, input);
    assert.equal(coerceComparableValue(input, schema(format)), Date.parse(input), input);
  }
});

test("strict date coercion preserves valid leap days and zoned timestamps", () => {
  for (const [format, input] of [
    ["date", "2024-02-29"],
    ["date", "0000-02-29"],
    ["date-time", "2024-02-29T23:30:00.125-05:00"],
    ["date-time", "2024-02-29t12:30:00z"],
  ] as const) {
    assert.equal(coerceComparableValue(input, schema(format), { strict: true }), Date.parse(input));
  }
});
