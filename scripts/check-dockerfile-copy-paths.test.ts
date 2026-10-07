// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";

import { checkDockerfile } from "./check-dockerfile-copy-paths.ts";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "pdpp-dockerfile-copy-"));
  cleanupDirs.push(dir);
  return dir;
}

test("reports literal COPY sources that are missing from the build context", () => {
  const repoRoot = makeRepo();
  writeFileSync(
    path.join(repoRoot, "Dockerfile"),
    ["FROM scratch", "COPY package.json package-lock.json ./", "COPY missing.ts /app/missing.ts"].join("\n")
  );
  writeFileSync(path.join(repoRoot, "package.json"), "{}\n");

  assert.deepEqual(checkDockerfile("Dockerfile", repoRoot), [
    { dockerfile: "Dockerfile", line: 2, path: "package-lock.json" },
    { dockerfile: "Dockerfile", line: 3, path: "missing.ts" },
  ]);
});

test("ignores dynamic, wildcard, and build-context COPY sources", () => {
  const repoRoot = makeRepo();
  writeFileSync(
    path.join(repoRoot, "Dockerfile"),
    ["FROM scratch", "COPY . ./", "COPY apps/*/package.json ./", "COPY $RUNTIME_FILE ./"].join("\n")
  );

  assert.deepEqual(checkDockerfile("Dockerfile", repoRoot), []);
});

test("missing Dockerfiles are skipped so optional paths do not fail the checker", () => {
  assert.deepEqual(checkDockerfile("missing.Dockerfile", makeRepo()), []);
});
