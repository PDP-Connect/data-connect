// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { resolveConnectorIcon } from "./resolve-connector-icon.ts";

test("resolveConnectorIcon accepts a non-empty inline SVG", () => {
  assert.deepEqual(
    resolveConnectorIcon({ color: "#111", kind: "inline_svg", svg: "  <svg />  " }),
    { color: "#111", kind: "inline_svg", svg: "<svg />" }
  );
});

test("resolveConnectorIcon returns null for a missing or unusable mark", () => {
  assert.equal(resolveConnectorIcon(null), null);
  assert.equal(resolveConnectorIcon(undefined), null);
  assert.equal(resolveConnectorIcon({ kind: "inline_svg", svg: "   " }), null);
  assert.equal(resolveConnectorIcon({ kind: "external_url", svg: "https://example.test/logo.svg" }), null);
});
