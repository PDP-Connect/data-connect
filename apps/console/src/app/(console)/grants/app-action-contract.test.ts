// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import baseline from "./app-action-contract.json" with { type: "json" };
for (const [file, expected] of Object.entries(baseline))
  test(`${file} keeps its server calls, validation and arguments`, () => {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(new URL(file, import.meta.url)))
        .digest("hex"),
      expected
    );
  });
test("technical filters retain every server query argument", () => {
  const source = readFileSync(new URL("./technical/page.tsx", import.meta.url), "utf8");
  for (const field of ["client_id", "cursor", "q", "source_id", "source_kind", "status"])
    assert.ok(source.includes(`${field}: params.${field}`));
  assert.ok(source.includes("limit: 50"));
  assert.ok(source.includes("listGrants(filters)"));
});
