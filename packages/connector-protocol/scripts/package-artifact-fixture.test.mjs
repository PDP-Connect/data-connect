// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createArtifactTestFixture, isolatedGitEnv } from "./package-artifact-fixture.mjs";

const execFile = promisify(execFileCallback);
const ASSUME_UNCHANGED_LINE = /^h /m;
const CALLER_REPOSITORY_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
const SCRIPT_PATHS = [
  "packages/connector-protocol/scripts/package-artifact.mjs",
  "packages/collector-runtime/scripts/package-artifact.mjs",
];
const COMMITTER = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];

async function git(args, cwd) {
  const { stdout } = await execFile("git", args, { cwd, env: await isolatedGitEnv() });
  return stdout;
}

// A disposable repository that tracks the same script paths the fixture marks
// assume-unchanged, so a leaked write would be visible in its index.
async function createCallerRepository() {
  const callerRoot = await mkdtemp(join(tmpdir(), "pdpp-artifact-caller-"));
  await git(["init", "--quiet"], callerRoot);
  await Promise.all(
    SCRIPT_PATHS.map(async (path) => {
      await mkdir(join(callerRoot, dirname(path)), { recursive: true });
      await writeFile(join(callerRoot, path), "// caller copy\n");
    })
  );
  await git(["add", "--", ...SCRIPT_PATHS], callerRoot);
  await git([...COMMITTER, "commit", "--quiet", "-m", "caller"], callerRoot);
  return callerRoot;
}

async function indexSnapshot(callerRoot) {
  const bytes = await readFile(join(callerRoot, ".git", "index"));
  return {
    flags: await git(["ls-files", "-v"], callerRoot),
    indexSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

for (const variables of [["GIT_INDEX_FILE"], ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]]) {
  test(`artifact fixture leaves the caller's repository alone with ${variables.join(" + ")} set`, async () => {
    const callerRoot = await createCallerRepository();
    const saved = Object.fromEntries(CALLER_REPOSITORY_VARIABLES.map((name) => [name, process.env[name]]));
    let fixture;
    try {
      const before = await indexSnapshot(callerRoot);
      assert.doesNotMatch(
        before.flags,
        ASSUME_UNCHANGED_LINE,
        "precondition: no assume-unchanged entries in the caller repository"
      );
      const values = {
        GIT_DIR: join(callerRoot, ".git"),
        GIT_INDEX_FILE: join(callerRoot, ".git", "index"),
        GIT_WORK_TREE: callerRoot,
      };
      for (const name of variables) {
        process.env[name] = values[name];
      }

      fixture = await createArtifactTestFixture("connector-protocol");

      restoreEnv(saved);
      assert.deepEqual(await indexSnapshot(callerRoot), before);
      const fixtureFlags = await git(["ls-files", "-v", "--", ...SCRIPT_PATHS], fixture.root);
      assert.equal(fixtureFlags.split("\n").filter((line) => line.startsWith("h ")).length, SCRIPT_PATHS.length);
    } finally {
      restoreEnv(saved);
      if (fixture) {
        await rm(fixture.root, { force: true, recursive: true });
      }
      await rm(callerRoot, { force: true, recursive: true });
    }
  });
}

test("isolatedGitEnv removes every repository-location variable git names and keeps the rest", async () => {
  const names = (await git(["rev-parse", "--local-env-vars"], tmpdir())).split("\n").filter(Boolean);
  assert.ok(names.includes("GIT_INDEX_FILE") && names.includes("GIT_DIR"));
  const env = await isolatedGitEnv({ ...Object.fromEntries(names.map((name) => [name, "x"])), KEEP_ME: "1" });
  assert.deepEqual(env, { KEEP_ME: "1" });
});
