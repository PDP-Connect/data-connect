// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const here = new URL("./", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, here), "utf8");

test("Stop on a running sync is a real button, not an underlined caption", () => {
  const src = read("stop-copying.tsx");
  assert.match(src, /buttonVariants\(/);
  assert.doesNotMatch(src, /variant: "outline"/);
});
