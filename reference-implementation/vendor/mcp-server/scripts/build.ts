// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(packageRoot, "dist");

await rm(distRoot, { force: true, recursive: true });
// execFile resolves a bare command name via PATH lookup only; on win32 that
// misses the .cmd shim npm writes for bin entries (no shell means no PATHEXT
// resolution), so this failed with ENOENT on every Windows build of a
// consumer package that vendors this script.
await execFileAsync("npx", ["tsc", "--project", "tsconfig.build.json"], {
  cwd: packageRoot,
  shell: platform === "win32",
});
await chmod(join(distRoot, "bin", "pdpp-mcp-server.js"), 0o755);
