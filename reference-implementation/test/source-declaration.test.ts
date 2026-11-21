// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLocalSchemaReferences } from "../server/source-declaration.ts";

test("accepts local JSON Pointers to ordinary and escaped schema keys", () => {
  const schema = {
    $defs: { item: { type: "string" }, "a/b~ c": true },
    allOf: [{ $ref: "#/$defs/item" }, { $ref: "#/$defs/a~1b~0%20c" }],
  };
  assert.doesNotThrow(() => assertLocalSchemaReferences(schema, "/streams/0/schema"));
});

test("accepts references within a nested schema resource and leaves anchors alone", () => {
  const schema = {
    $defs: {
      local: {
        $id: "local.json",
        $defs: { item: { $anchor: "item", type: "string" } },
        allOf: [{ $ref: "#/$defs/item" }, { $ref: "#item" }],
      },
    },
    $ref: "#",
  };
  assert.doesNotThrow(() => assertLocalSchemaReferences(schema, "/streams/0/schema"));
});
