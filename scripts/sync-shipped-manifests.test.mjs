// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("invalid upstream regeneration preserves the complete previous snapshot", () => fixture(({ root, snapshot, invoke }) => {
  const before = ["provenance.json", "connectors/example/manifest.json"].map((path) => readFileSync(join(snapshot, path)));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  mkdirSync(join(root, "connectors/first"), { recursive: true });
  mkdirSync(join(root, "connectors/last"), { recursive: true });
  writeFileSync(join(root, "connectors/first/manifest.json"), before[1]);
  writeFileSync(join(root, "connectors/last/manifest.json"), "{}");
  git("add", "connectors");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
  const result = invoke("--commit", git("rev-parse", "HEAD"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing source.id/);
  for (const [index, path] of ["provenance.json", "connectors/example/manifest.json"].entries()) {
    assert.deepEqual(readFileSync(join(snapshot, path)), before[index], path);
  }
  git("rm", "--quiet", "connectors/last/manifest.json");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "valid fixture");
  const commit = git("rev-parse", "HEAD");
  const valid = invoke("--commit", commit);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(readFileSync(join(snapshot, "provenance.json"))).commit, commit);
  assert.equal(existsSync(join(snapshot, "connectors/example")), false);
  assert.deepEqual(readFileSync(join(snapshot, "connectors/first/manifest.json")), before[1]);
}));
