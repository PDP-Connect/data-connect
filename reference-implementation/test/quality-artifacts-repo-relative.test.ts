// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generated quality artifacts under `quality/` (inventories, packets, receipts,
 * claims) are tracked, so they must not record the filesystem layout of the
 * machine that produced them. Every path must be repo-relative or a neutral
 * placeholder such as `$HONE_ROOT/`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ABSOLUTE_PATH = /(?:^|[\s"'`=(:,])(?:\/(?:home|Users|root|tmp)\/|~\/|[A-Za-z]:[\\/])/;

const trackedFiles = execFileSync("git", ["ls-files", "-z", "--", "quality"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

test("tracked quality artifacts exist to be checked", () => {
  assert.ok(trackedFiles.length > 0, "git ls-files returned no files under quality/");
});

test("tracked quality artifacts contain no absolute filesystem paths", () => {
  const offenders: string[] = [];
  for (const file of trackedFiles) {
    readFileSync(join(repoRoot, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (ABSOLUTE_PATH.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
  }
  assert.deepEqual(offenders, [], "absolute paths found; rewrite them repo-relative");
});

test("inventory and packet repo_root values are relative", () => {
  for (const file of trackedFiles.filter((f) => /^quality\/(inventory\/.*\.json|packets\/.*\.yaml)$/.test(f))) {
    const text = readFileSync(join(repoRoot, file), "utf8");
    for (const match of text.matchAll(/"?repo_root"?:\s*"([^"]*)"/g)) {
      assert.ok(!/^(?:\/|~|[A-Za-z]:[\\/])/.test(match[1] ?? ""), `${file}: repo_root is absolute: ${match[1]}`);
    }
  }
});
