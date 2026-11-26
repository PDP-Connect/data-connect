// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture(run) {
  const root = mkdtempSync(join(homedir(), ".tmp", "dc-snapshot-test-"));
  const snapshot = join(root, "reference-implementation/test/fixtures/shipped-manifests");
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(new URL("./sync-shipped-manifests.mjs", import.meta.url), join(root, "scripts/sync-shipped-manifests.mjs"));
    mkdirSync(join(snapshot, "connectors/example"), { recursive: true });
    const bytes = JSON.stringify({ source: { id: "https://example.org/source" }, streams: [], runtime_requirements: {} });
    writeFileSync(join(snapshot, "connectors/example/manifest.json"), bytes);
    writeFileSync(join(snapshot, "provenance.json"), JSON.stringify({ commit: "a".repeat(40), files: { "connectors/example/manifest.json": createHash("sha256").update(bytes).digest("hex") } }));
    const invoke = (...args) => spawnSync(process.execPath, [join(root, "scripts/sync-shipped-manifests.mjs"), ...args], {
      env: { ...process.env, DATA_CONNECTORS_REMOTE: join(root, "missing-remote"), DATA_CONNECTORS_REPO: root }, encoding: "utf8", timeout: 15000,
    });
    run({ root, snapshot, invoke });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("integrity check succeeds offline and rejects changed bytes", () => fixture(({ snapshot, invoke }) => {
  assert.equal(invoke("--check").status, 0);
  writeFileSync(join(snapshot, "connectors/example/manifest.json"), "{}");
  assert.notEqual(invoke("--check").status, 0);
}));

test("freshness lookup failure warns without failing correct integrity", () => fixture(({ invoke }) => {
  const result = invoke("--check", "--freshness");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /freshness lookup failed/);
}));
