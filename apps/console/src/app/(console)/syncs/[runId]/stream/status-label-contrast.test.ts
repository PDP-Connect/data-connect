// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The word beside the dot sits on top of the remote browser picture, so its contrast
// has to come from its own solid background, not from whatever page shows behind it.
test("the Live word sits on its own solid background in the text colour", () => {
  const src = readFileSync(new URL("./stream-viewer.tsx", import.meta.url), "utf8");
  const start = src.indexOf("function StatusDot");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /rounded-full bg-background px-2/);
  assert.match(body, /text-foreground/);
  assert.doesNotMatch(body, /text-muted-foreground/);
});
