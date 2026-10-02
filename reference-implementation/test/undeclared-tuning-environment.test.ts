// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";
import { tuningEnvironmentKeyOwner } from "../runtime/connector-child-environment.ts";
import { UNDECLARED_TUNING_ENVIRONMENT } from "../runtime/undeclared-tuning-environment.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";

const REFERENCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function shippedManifestsByKey(): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const { manifest } of readPolyfillManifests()) {
    const key = canonicalConnectorKey((manifest as { connector_id?: unknown }).connector_id);
    if (key) {
      out.set(key, manifest as Record<string, unknown>);
    }
  }
  return out;
}

test("every transitional entry is a shipped first-party connector that owns its keys", () => {
  const shipped = shippedManifestsByKey();
  for (const [connectorKey, keys] of Object.entries(UNDECLARED_TUNING_ENVIRONMENT)) {
    assert.ok(shipped.has(connectorKey), `${connectorKey} is not a shipped first-party connector`);
    for (const key of keys) {
      assert.equal(tuningEnvironmentKeyOwner(key), connectorKey, `${key} is not owned by ${connectorKey}`);
    }
  }
});

test("a transitional entry is deleted once the pinned manifest declares tuning_environment", () => {
  const shipped = shippedManifestsByKey();
  for (const connectorKey of Object.keys(UNDECLARED_TUNING_ENVIRONMENT)) {
    const requirements = shipped.get(connectorKey)?.runtime_requirements as Record<string, unknown> | undefined;
    assert.equal(
      requirements?.tuning_environment,
      undefined,
      `${connectorKey} now declares runtime_requirements.tuning_environment; delete its entry from ` +
        "runtime/undeclared-tuning-environment.ts after checking that the manifest lists every key the entry had"
    );
  }
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "generated") {
        out.push(...sourceFiles(path));
      }
    } else if (/\.(?:ts|js|mjs)$/.test(entry.name) && !/\.test\.(?:ts|js|mjs)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

test("the reference server reads no key inside a first-party connector tuning namespace", () => {
  // A first-party manifest can pass any key in its own PDPP_<KEY>_ namespace
  // from the server environment to its child. If the server itself used such
  // a key (for example a credential), a manifest could forward it. Keep the
  // namespaces disjoint from the server's own configuration. Comment lines are
  // skipped: they document a key, they do not read it.
  const owned = new Set(Object.values(UNDECLARED_TUNING_ENVIRONMENT).flat());
  const collisions: string[] = [];
  for (const dir of ["server", "runtime"]) {
    for (const file of sourceFiles(join(REFERENCE_ROOT, dir))) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
        .join("\n");
      for (const [key] of code.matchAll(/\bPDPP_[A-Z0-9_]+\b/g)) {
        const owner = tuningEnvironmentKeyOwner(key);
        if (owner !== null && !owned.has(key)) {
          collisions.push(`${relative(REFERENCE_ROOT, file)}: ${key} (namespace of ${owner})`);
        }
      }
    }
  }
  assert.deepEqual(collisions, []);
});
