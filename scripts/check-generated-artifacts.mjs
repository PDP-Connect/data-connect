#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "connectors", "lock.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function missingConnectorSourceFiles() {
  if (!existsSync(lockPath)) {
    return ["connectors/lock.json"];
  }
  const lock = readJson(lockPath);
  return (lock.connectors ?? [])
    .flatMap((entry) => Object.values(entry.sourceFiles ?? {}))
    .filter((path) => typeof path === "string" && !existsSync(join(root, "connectors", path)));
}

const missing = missingConnectorSourceFiles();
if (missing.length > 0) {
  console.warn(
    `[generated-artifacts:check] skipped platform registry check; connector source files are not present in this checkout (${missing[0]}${missing.length > 1 ? ` and ${missing.length - 1} more` : ""}). Run npm run connectors:resolve before this check in a full artifact-bearing checkout.`
  );
  process.exit(0);
}

for (const command of [
  ["node", ["scripts/generate-platform-registry.js"]],
  ["git", ["diff", "--exit-code", "--", "src/lib/platform/registry.generated.ts"]],
]) {
  const result = spawnSync(command[0], command[1], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
