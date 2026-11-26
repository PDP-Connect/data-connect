// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGit } from "./git-runner.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packages = ["connector-protocol", "collector-runtime"];
const GIT_RUNNER_PATH = "packages/connector-protocol/scripts/git-runner.mjs";

// Every git subprocess of the fixture goes through the shared sanitized runner;
// the repository is the `cwd`, so a clone is started from the source checkout.
function git(args, { cwd = repoRoot } = {}) {
  return runGit(args, { cwd });
}

export async function createArtifactTestFixture(packageName) {
  const started = performance.now();
  const root = await mkdtemp(join(tmpdir(), "pdpp-artifact-test-"));
  try {
    await git(["clone", "--shared", "--no-checkout", "--", repoRoot, root]);
    await git(["checkout", "HEAD", "--", ".gitignore", ...packages.map((name) => `packages/${name}`)], {
      cwd: root,
    });
    await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"));
    await Promise.all(
      packages.map(async (name) => {
        const packagePath = `packages/${name}`;
        await symlink(join(repoRoot, packagePath, "node_modules"), join(root, packagePath, "node_modules"));
        // Run the working-tree scripts, including uncommitted fixes or mutants.
        // Ignore only these harness overlays so the dirty guard sees the fixture edits.
        const scriptPath = `${packagePath}/scripts/package-artifact.mjs`;
        await copyFile(join(repoRoot, scriptPath), join(root, scriptPath));
      })
    );
    await copyFile(join(repoRoot, GIT_RUNNER_PATH), join(root, GIT_RUNNER_PATH));
    await git(
      [
        "update-index",
        "--assume-unchanged",
        "--",
        ...packages.map((name) => `packages/${name}/scripts/package-artifact.mjs`),
        GIT_RUNNER_PATH,
      ],
      { cwd: root }
    );
    const packageRoot = join(root, "packages", packageName);
    const api = await import(pathToFileURL(join(packageRoot, "scripts/package-artifact.mjs")));
    return { api, checkoutMs: performance.now() - started, packageRoot, root };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}
