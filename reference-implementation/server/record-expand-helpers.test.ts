// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeExpandRequest } from "./record-expand-helpers.ts";

test("configured expansion limits preserve valid defaults and explicit bounds", () => {
  type Manifest = Parameters<typeof normalizeExpandRequest>[3];
  const grant = { streams: [{ name: "fixture_child" }] };
  const manifest: Manifest = {
    relationships: [{ name: "fixture", stream: "fixture_child", cardinality: "has_many" }],
    query: { expand: [{ name: "fixture", default_limit: 2, max_limit: 4 }] },
  };
  assert.equal(normalizeExpandRequest({ expand: "fixture" }, "parent", grant, manifest, null)[0]?.limit, 2);
  for (const limit of [1, 4]) {
    assert.equal(normalizeExpandRequest({
      expand: "fixture", expand_limit: { fixture: limit },
    }, "parent", grant, manifest, null)[0]?.limit, limit);
  }
});
