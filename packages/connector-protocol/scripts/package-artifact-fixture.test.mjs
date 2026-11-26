// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { isolatedGitEnv, runGit } from "./git-runner.mjs";
import { createArtifactTestFixture } from "./package-artifact-fixture.mjs";

const COMMIT_FIRST_ERROR = /commit first/i;
const NEEDS_CWD_ERROR = /needs a cwd/;
const ASSUME_UNCHANGED_LINE = /^h /m;
const CALLER_REPOSITORY_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
const SCRIPT_PATHS = [
  "packages/connector-protocol/scripts/package-artifact.mjs",
  "packages/collector-runtime/scripts/package-artifact.mjs",
  "packages/connector-protocol/scripts/git-runner.mjs",
];
const README_PATHS = ["packages/connector-protocol/README.md", "packages/collector-runtime/README.md"];
const CALLER_README = "caller readme\n";
const COMMITTER = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];

async function git(args, cwd) {
  const { stdout } = await runGit(args, { cwd });
  return stdout;
}

// A disposable repository that tracks the same script paths the fixture marks
// assume-unchanged, so a leaked write would be visible in its index.
async function createCallerRepository() {
  const callerRoot = await mkdtemp(join(tmpdir(), "pdpp-artifact-caller-"));
  await git(["init", "--quiet"], callerRoot);
  await Promise.all(
    [...SCRIPT_PATHS, ...README_PATHS].map(async (path) => {
      await mkdir(join(callerRoot, dirname(path)), { recursive: true });
      await writeFile(join(callerRoot, path), README_PATHS.includes(path) ? CALLER_README : "// caller copy\n");
    })
  );
  await git(["add", "--", ...SCRIPT_PATHS, ...README_PATHS], callerRoot);
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

async function withCallerEnvironment(variables, callerRoot, body) {
  const values = {
    GIT_DIR: join(callerRoot, ".git"),
    GIT_INDEX_FILE: join(callerRoot, ".git", "index"),
    GIT_WORK_TREE: callerRoot,
  };
  const saved = Object.fromEntries(CALLER_REPOSITORY_VARIABLES.map((name) => [name, process.env[name]]));
  Object.assign(process.env, Object.fromEntries(variables.map((name) => [name, values[name]])));
  try {
    return await body();
  } finally {
    restoreEnv(saved);
  }
}

test("the committed-files guard checks the checkout's own index when GIT_INDEX_FILE names another", async () => {
  const fixture = await createArtifactTestFixture("connector-protocol");
  try {
    const readmePath = join(fixture.packageRoot, "README.md");
    const original = await readFile(readmePath, "utf8");
    const pristineIndex = join(fixture.root, ".git", "pristine-index");
    await copyFile(join(fixture.root, ".git", "index"), pristineIndex);
    // Stage an edit, then restore the working file: only the real index
    // shows the package as changed.
    await writeFile(readmePath, `${original}staged edit\n`);
    await git(["add", "--", "packages/connector-protocol/README.md"], fixture.root);
    await writeFile(readmePath, original);

    await assert.rejects(fixture.api.assertPackageDirectoriesCommitted(), COMMIT_FIRST_ERROR);
    await withCallerEnvironment(["GIT_INDEX_FILE"], fixture.root, async () => {
      process.env.GIT_INDEX_FILE = pristineIndex;
      await assert.rejects(fixture.api.assertPackageDirectoriesCommitted(), COMMIT_FIRST_ERROR);
    });
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("a GIT_DIR naming another repository does not change the HEAD the artifact scripts read", async () => {
  const callerRoot = await createCallerRepository();
  const fixture = await createArtifactTestFixture("collector-runtime");
  let cloneDir;
  try {
    const expectedHead = (await git(["rev-parse", "HEAD"], fixture.root)).trim();
    const expectedReadme = await readFile(join(fixture.packageRoot, "README.md"), "utf8");
    assert.notEqual(expectedReadme, CALLER_README);
    await withCallerEnvironment(["GIT_DIR", "GIT_WORK_TREE"], callerRoot, async () => {
      assert.equal((await runGit(["rev-parse", "HEAD"], { cwd: fixture.root })).stdout.trim(), expectedHead);
      const clone = await fixture.api.cloneCommittedSourceTree();
      ({ cloneDir } = clone);
      assert.equal(await readFile(join(clone.clonedRuntimeRoot, "README.md"), "utf8"), expectedReadme);
    });
  } finally {
    if (cloneDir) {
      await rm(cloneDir, { force: true, recursive: true });
    }
    await rm(fixture.root, { force: true, recursive: true });
    await rm(callerRoot, { force: true, recursive: true });
  }
});

test("runGit refuses to start without a cwd", async () => {
  await assert.rejects(runGit(["rev-parse", "HEAD"], {}), NEEDS_CWD_ERROR);
});
