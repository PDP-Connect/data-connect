// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";
import { isServerOwnedEnvironmentKey, SERVER_OWNED_ENVIRONMENT } from "../runtime/server-owned-environment.ts";

const REFERENCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The set lists names the server mentions. These two files are the only
// non-test sources the scan skips: the set itself, and the table of connector
// knobs, which belong to their connectors and are not server configuration.
const SKIPPED_FILES = new Set(["runtime/server-owned-environment.ts", "runtime/undeclared-tuning-environment.ts"]);
const SCANNED_DIRECTORIES = ["server", "runtime", "lib", "cli"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        out.push(...sourceFiles(path));
      }
    } else if (/\.(?:ts|js|mjs|cjs)$/.test(entry.name) && !/\.test\.(?:ts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Every PDPP_* name non-comment source mentions, with the files that mention it. */
function mentionedNames(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const directory of SCANNED_DIRECTORIES) {
    for (const file of sourceFiles(join(REFERENCE_ROOT, directory))) {
      const relativePath = relative(REFERENCE_ROOT, file);
      if (SKIPPED_FILES.has(relativePath)) {
        continue;
      }
      // Comment lines document a name; they do not read it.
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
        .join("\n");
      for (const [name] of code.matchAll(/\bPDPP_[A-Z0-9_]*[A-Z0-9]\b/g)) {
        out.set(name, [...(out.get(name) ?? []), relativePath]);
      }
    }
  }
  return out;
}

test("every PDPP_ name the server, runtime, library and CLI sources mention is server-owned", () => {
  const missing = [...mentionedNames()]
    .filter(([name]) => !SERVER_OWNED_ENVIRONMENT.has(name))
    .map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`);
  assert.deepEqual(
    missing,
    [],
    "add each name to SERVER_OWNED_ENVIRONMENT in runtime/server-owned-environment.ts: a connector must not be able to claim it"
  );
});

test("the server-owned set lists no name the sources stopped mentioning", () => {
  const mentioned = mentionedNames();
  const stale = [...SERVER_OWNED_ENVIRONMENT].filter((name) => !mentioned.has(name));
  assert.deepEqual(stale, [], "delete these names from SERVER_OWNED_ENVIRONMENT: no source mentions them any more");
});

test("no shipped connector manifest declares a server-owned name as a tuning key", () => {
  const claimed: string[] = [];
  for (const { manifest } of readPolyfillManifests()) {
    const requirements = (manifest as { runtime_requirements?: { tuning_environment?: unknown } }).runtime_requirements;
    const declared = Array.isArray(requirements?.tuning_environment) ? requirements.tuning_environment : [];
    for (const key of declared) {
      if (typeof key === "string" && isServerOwnedEnvironmentKey(key)) {
        claimed.push(`${(manifest as { connector_id?: unknown }).connector_id}: ${key}`);
      }
    }
  }
  assert.deepEqual(claimed, []);
});

test("the server-owned set covers the variable that motivated it", () => {
  for (const name of ["PDPP_DATABASE_URL", "PDPP_STORAGE_BACKEND", "PDPP_OWNER_PASSWORD", "PDPP_DATA_DIR"]) {
    assert.ok(isServerOwnedEnvironmentKey(name), name);
  }
  assert.equal(isServerOwnedEnvironmentKey("pdpp_database_url"), true);
  assert.equal(isServerOwnedEnvironmentKey("PDPP_DATABASE_PAGE_SIZE"), false);
});
