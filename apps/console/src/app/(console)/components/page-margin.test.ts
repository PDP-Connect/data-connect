// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

// Round 9 (F37): the shell already pads the page (16px on a phone, 32px on a desktop). A page that adds its own
// `px-4 py-6` pushes its title to 32px and 24px lower than every other page.
test("no page adds its own side padding on top of the shell's", () => {
  const offenders = files(ROOT).filter((file) => /max-w-5xl[^"`]*\bpx-4 py-6\b/.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders.map((file) => file.slice(ROOT.length)), []);
});
