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

test("rejects a dangling or remote reference in any schema position", () => {
  const positions = [
    { $ref: "#/$defs/missing" },
    { properties: { name: { $ref: "#/$defs/missing" } } },
    { items: { $ref: "#/$defs/missing" } },
    { prefixItems: [{ $ref: "#/$defs/missing" }] },
    { anyOf: [{ not: { $ref: "#/$defs/missing" } }] },
    { $defs: { item: { additionalProperties: { $ref: "#/$defs/missing" } } } },
    { properties: { name: { $ref: "https://example.com/schema.json" } } },
  ];
  for (const schema of positions) {
    assert.throws(() => assertLocalSchemaReferences(schema, "/streams/0/schema"), /local/u, JSON.stringify(schema));
  }
});

test("a literal $ref inside example data or a property name is not a reference", () => {
  const schema = {
    type: "object",
    properties: {
      $ref: { type: "string" },
      note: {
        type: "object",
        examples: [{ $ref: "#/example-only" }],
        default: { $ref: "https://example.com/not-fetched" },
        const: { $ref: "#/example-only" },
        enum: [{ $ref: "#/example-only" }],
      },
    },
  };
  assert.doesNotThrow(() => assertLocalSchemaReferences(schema, "/streams/0/schema"));
  // The same pointer as a real reference beside the example is still checked.
  const withReal = { ...schema, allOf: [{ $ref: "#/example-only" }] };
  assert.throws(() => assertLocalSchemaReferences(withReal, "/streams/0/schema"), /existing local schema/u);
});
