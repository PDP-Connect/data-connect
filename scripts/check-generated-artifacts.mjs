#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "connectors", "lock.json");

const checkedGeneratedPaths = [
  "reference-implementation/server/generated/connector-registry.generated.ts",
  "reference-implementation/vendor/cli/src/ref/list-envelope.ts",
  "src/lib/platform/registry.generated.ts",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

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

function assertGeneratedArtifactCurrent({ label, generator, trackedPath }) {
  const scratchDir = mkdtempSync(join(tmpdir(), "pdpp-generated-artifacts-"));
  try {
    const scratchPath = join(scratchDir, trackedPath.split("/").at(-1));
    run(generator.command, [...generator.args, scratchPath]);
    const generated = readFileSync(scratchPath, "utf8");
    const tracked = readFileSync(join(root, trackedPath), "utf8");
    if (generated !== tracked) {
      console.error(`[generated-artifacts:check] ${label} is stale: ${trackedPath}`);
      console.error(`[generated-artifacts:check] rerun: ${generator.refreshCommand}`);
      process.exit(1);
    }
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
}

assertGeneratedArtifactCurrent({
  label: "reference implementation connector registry",
  generator: {
    command: "node",
    args: [
      "--experimental-strip-types",
      "reference-implementation/scripts/generate-connector-registry.ts",
    ],
    refreshCommand:
      "cd reference-implementation && node --experimental-strip-types scripts/generate-connector-registry.ts",
  },
  trackedPath: "reference-implementation/server/generated/connector-registry.generated.ts",
});

assertGeneratedArtifactCurrent({
  label: "CLI list-envelope copy",
  generator: {
    command: "node",
    args: ["--experimental-strip-types", "reference-implementation/vendor/cli/scripts/generate-list-envelope.ts"],
    refreshCommand:
      "node --experimental-strip-types reference-implementation/vendor/cli/scripts/generate-list-envelope.ts",
  },
  trackedPath: "reference-implementation/vendor/cli/src/ref/list-envelope.ts",
});

const missing = missingConnectorSourceFiles();
if (missing.length > 0) {
  console.warn(
    `[generated-artifacts:check] skipped platform registry check; connector source files are not present in this checkout (${missing[0]}${missing.length > 1 ? ` and ${missing.length - 1} more` : ""}). Run npm run connectors:resolve before this check in a full artifact-bearing checkout.`
  );
} else {
  run("node", ["scripts/generate-platform-registry.js"]);
}

run("git", ["diff", "--exit-code", "--", ...checkedGeneratedPaths]);
run("git", ["diff", "--cached", "--exit-code", "--", ...checkedGeneratedPaths]);
