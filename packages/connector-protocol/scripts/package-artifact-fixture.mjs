// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packages = ["connector-protocol", "collector-runtime"];

export async function createArtifactTestFixture(packageName) {
  const started = performance.now();
  const root = await mkdtemp(join(tmpdir(), "pdpp-artifact-test-"));
  try {
    await execFile("git", ["clone", "--shared", "--no-checkout", "--", repoRoot, root]);
    await execFile("git", ["checkout", "HEAD", "--", ".gitignore", ...packages.map((name) => `packages/${name}`)], {
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
    await execFile(
      "git",
      [
        "update-index",
        "--assume-unchanged",
        "--",
        ...packages.map((name) => `packages/${name}/scripts/package-artifact.mjs`),
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
