// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

let repositoryLocationVariables;

// Git itself names the variables that point it at a repository, index or
// object store (`git rev-parse --local-env-vars`). A hook or a wrapper shell
// can set them, and a child git that inherits them acts on the caller's
// repository instead of the one in its `cwd`.
function repositoryLocationVariableNames() {
  repositoryLocationVariables ??= execFile("git", ["rev-parse", "--local-env-vars"]).then(({ stdout }) =>
    stdout.split("\n").filter(Boolean)
  );
  return repositoryLocationVariables;
}

export async function isolatedGitEnv(env = process.env) {
  const isolated = { ...env };
  for (const name of await repositoryLocationVariableNames()) {
    delete isolated[name];
  }
  return isolated;
}

/**
 * The one way the package artifact scripts and their test fixture start git.
 * The repository is chosen by `cwd` alone; the caller's repository-location
 * variables never reach the child.
 */
export async function runGit(args, { cwd, ...options }) {
  if (!cwd) {
    throw new Error("runGit needs a cwd: the repository is chosen by cwd, not by the environment");
  }
  return execFile("git", args, { ...options, cwd, env: await isolatedGitEnv() });
}
