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

// Mutation testing runs the suite from an untracked sandbox copy that excludes
// quality/, so this file must load outside a git checkout. Derive the root from
// this file's path and skip, rather than throw, when git cannot list the files.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const QUALITY_DIR = "reference-implementation/quality";

// Local roots a machine layout can leak through, including macOS temp and
// system-volume roots. Deliberately omits /usr/ and /etc/.
const ABSOLUTE_PATH =
  /(?:^|[\s"'`=(:,])(?:\/(?:home|Users|root|tmp|opt|private|var\/folders)\/|~\/|[A-Za-z]:[\\/])/;

function listTrackedFiles(): { files: string[]; skipReason?: string } {
  try {
    const files = execFileSync("git", ["ls-files", "-z", "--", QUALITY_DIR], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
    if (files.length === 0) return { files, skipReason: `no tracked files under ${QUALITY_DIR}/ (not a git checkout)` };
    return { files };
  } catch {
    return { files: [], skipReason: "git is unavailable or this is not a git checkout" };
  }
}

const { files: trackedFiles, skipReason } = listTrackedFiles();
const skip = skipReason ?? false;

test("tracked quality artifacts exist to be checked", { skip }, () => {
  assert.ok(trackedFiles.length > 0, `git ls-files returned no files under ${QUALITY_DIR}/`);
});

test("tracked quality artifacts contain no absolute filesystem paths", { skip }, () => {
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

test("inventory and packet repo_root values are relative", { skip }, () => {
  for (const file of trackedFiles.filter((f) => /^reference-implementation\/quality\/(inventory\/.*\.json|packets\/.*\.yaml)$/.test(f))) {
    const text = readFileSync(join(repoRoot, file), "utf8");
    for (const match of text.matchAll(/"?repo_root"?:\s*"([^"]*)"/g)) {
      assert.ok(!/^(?:\/|~|[A-Za-z]:[\\/])/.test(match[1] ?? ""), `${file}: repo_root is absolute: ${match[1]}`);
    }
  }
});
