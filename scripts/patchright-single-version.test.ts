// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// One Patchright for the whole workspace. The Dockerfile installs the browser
// revision of reference-implementation's exact `patchright` pin, and
// runtime/browser-executable.ts checks for that revision. A second copy of
// Patchright in the lockfile (for example one pinned by the vendored
// @pdpp/polyfill-connectors tarball) launches a different Chromium revision
// than the one the image installs. The root `overrides` entry for
// @pdpp/polyfill-connectors keeps the tree on one version.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function lockedPatchrightEntries(): Array<{ key: string; version: string }> {
  const lock = readJson("package-lock.json");
  return Object.entries<{ version?: string }>(lock.packages)
    .filter(([key]) => /(^|\/)node_modules\/patchright(-core)?$/.test(key))
    .map(([key, entry]) => ({ key, version: String(entry.version) }));
}

test("package-lock.json resolves every patchright and patchright-core copy to the image's pin", () => {
  const pin = readJson("reference-implementation/package.json").dependencies.patchright;
  assert.match(pin, /^\d+\.\d+\.\d+$/, "reference-implementation must pin patchright exactly");

  const entries = lockedPatchrightEntries();
  assert.ok(
    entries.some((entry) => entry.key === "node_modules/patchright"),
    "lockfile has no top-level patchright entry"
  );
  assert.ok(
    entries.some((entry) => entry.key === "node_modules/patchright-core"),
    "lockfile has no top-level patchright-core entry"
  );
  const stray = entries.filter((entry) => entry.version !== pin);
  assert.deepEqual(stray, [], `lockfile entries not on patchright ${pin}`);
});

test("the root patchright dependency matches the reference-implementation pin", () => {
  assert.equal(
    readJson("package.json").dependencies.patchright,
    readJson("reference-implementation/package.json").dependencies.patchright
  );
});
