// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The repository vendors scripts/test-sandbox/test-sandbox verbatim from its
// canonical source (see scripts/test-sandbox/README.md). This check fails when
// the copy no longer matches its recorded digest, so the copy cannot drift
// through a local edit that nobody carried back to the canonical tool.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sandboxDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "test-sandbox");

test("vendored test-sandbox matches its recorded sha256 and stays executable", () => {
  const recorded = readFileSync(join(sandboxDir, "test-sandbox.sha256"), "utf8").trim();
  const actual = createHash("sha256")
    .update(readFileSync(join(sandboxDir, "test-sandbox")))
    .digest("hex");
  assert.equal(recorded, `${actual}  test-sandbox`);
  // Windows reports no POSIX mode bits; Git still records the file as 100755.
  if (process.platform !== "win32") {
    assert.ok(statSync(join(sandboxDir, "test-sandbox")).mode & 0o100, "test-sandbox must be executable");
  }
});
