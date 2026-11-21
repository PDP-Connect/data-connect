// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { coerceSemanticTimeValue } from "./semantic-time-coercion.ts";

test("unparseable semantic time is unknown", () => {
  assert.equal(coerceSemanticTimeValue("not-a-date"), null);
});

test("a valid ISO instant is returned unchanged", () => {
  const instant = "2026-06-15T12:34:56.000Z";
  assert.equal(coerceSemanticTimeValue(instant), instant);
  assert.equal(coerceSemanticTimeValue(`  ${instant}  `), instant);
});

test("epoch sentinels still return null", () => {
  assert.equal(coerceSemanticTimeValue("1970-01-01T00:00:00.000Z"), null);
  assert.equal(coerceSemanticTimeValue("0001-01-01T00:00:00.000Z"), null);
  assert.equal(coerceSemanticTimeValue("0"), null);
});
