// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { hexColorOrNull } from "./hex-color.ts";

test("hexColorOrNull keeps #rgb and #rrggbb and drops everything else", () => {
  assert.equal(hexColorOrNull("#1ED760"), "#1ED760");
  assert.equal(hexColorOrNull("#fa0"), "#fa0");
  for (const bad of [
    "red",
    "#12",
    "#12345",
    "#12345g",
    "#1234567",
    "transparent",
    "#fff;x:y",
    " #fff",
    "",
    null,
    undefined,
    5,
  ]) {
    assert.equal(hexColorOrNull(bad), null, String(bad));
  }
});
