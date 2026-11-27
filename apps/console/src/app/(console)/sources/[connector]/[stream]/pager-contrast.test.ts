// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("../../../../../../../../reference-implementation/vendor/operator-ui/src/components/primitives.tsx", import.meta.url)),
  "utf8",
);
const pager = src.slice(src.indexOf("export function Pager"));

test("the pager hides itself when there is nothing to page", () => {
  assert.match(pager, /if \(!\(prev \|\| next\)\)/);
});

test("the pager's inactive links keep full text contrast", () => {
  assert.doesNotMatch(pager.slice(0, pager.indexOf("\n}\n")), /text-muted-foreground\/\d+/);
});
