// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { appendFile, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { computeSourceInputsDigest as computeProtocolSourceInputsDigest } from "../../connector-protocol/scripts/package-artifact.mjs";
import {
  assertProtocolBuildMatchesReceipt,
  cloneCommittedSourceTree,
  computeSourceInputsDigest,
  generateArtifactMetadata,
  verifyArtifactMetadata,
} from "./package-artifact.mjs";

const COMMIT_FIRST_ERROR = /commit first/i;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolRoot = resolve(packageRoot, "..", "connector-protocol");
const protocolSourcePath = resolve(packageRoot, "..", "connector-protocol", "src", "auth.ts");
const PROTOCOL_DECLARATIONS_DRIFT_ERROR = /connector-protocol declarations drift/;

test("runtime source inputs bind the connector-protocol source receipt", async () => {
  const original = await readFile(protocolSourcePath, "utf8");
  const before = await computeSourceInputsDigest();

  try {
    await appendFile(protocolSourcePath, "\n// artifact-input-mutant\n");
    const after = await computeSourceInputsDigest();
    assert.notEqual(after, before, "a connector-protocol source mutant must invalidate runtime source inputs");
  } finally {
    await writeFile(protocolSourcePath, original);
  }

  assert.equal(await readFile(protocolSourcePath, "utf8"), original);
});

test("runtime artifact validation rejects a stale connector-protocol declaration receipt", async () => {
  const metadata = JSON.parse(await readFile(resolve(protocolRoot, "artifact.json"), "utf8"));
  const sourceInputsSha256 = await computeProtocolSourceInputsDigest();

  assert.throws(
    () => assertProtocolBuildMatchesReceipt(metadata, sourceInputsSha256, "0".repeat(64)),
    PROTOCOL_DECLARATIONS_DRIFT_ERROR
  );
});

test("runtime clones resolve connector-protocol from their archived sibling", async () => {
  const clone = await cloneCommittedSourceTree();
  try {
    const resolvedProtocol = await realpath(
      resolve(clone.clonedRuntimeRoot, "node_modules", "@pdpp", "connector-protocol")
    );
    assert.equal(resolvedProtocol, await realpath(clone.clonedProtocolRoot));
  } finally {
    await rm(clone.cloneDir, { force: true, recursive: true });
  }
});

for (const untracked of [false, true]) {
  test(`generate refuses ${untracked ? "untracked" : "modified"} package source and names it`, async () => {
    const sourcePath = resolve(packageRoot, "src", untracked ? "artifact-untracked-fixture.ts" : "index.ts");
    const original = untracked ? null : await readFile(sourcePath);
    const metadataPath = resolve(packageRoot, "artifact.json");
    const metadata = await readFile(metadataPath);
    try {
      await appendFile(sourcePath, "\n// dirty artifact fixture\n");
      await assert.rejects(generateArtifactMetadata, (error) => {
        assert.match(error.message, COMMIT_FIRST_ERROR);
        assert.ok(error.message.includes(untracked ? "artifact-untracked-fixture.ts" : "index.ts"));
        return true;
      });
      assert.deepEqual(await readFile(metadataPath), metadata, "refusal must leave the receipt unchanged");
    } finally {
      if (untracked) {
        await rm(sourcePath, { force: true });
      } else {
        await writeFile(sourcePath, original);
      }
      await writeFile(metadataPath, metadata);
    }
  });
}

test("receipt digest and identity match HEAD despite working-tree edits", async () => {
  const sourcePath = resolve(packageRoot, "src", "index.ts");
  const manifestPath = resolve(packageRoot, "package.json");
  const source = await readFile(sourcePath);
  const manifest = await readFile(manifestPath, "utf8");
  const committedDigest = await computeSourceInputsDigest();
  try {
    await appendFile(sourcePath, "\n// dirty artifact fixture\n");
    assert.notEqual(await computeSourceInputsDigest(), committedDigest);
    const metadata = await verifyArtifactMetadata();
    assert.equal(metadata.source_inputs_sha256, committedDigest);
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(manifest), version: "99.0.0" }));
    assert.equal((await verifyArtifactMetadata()).package_version, JSON.parse(manifest).version);
  } finally {
    await writeFile(sourcePath, source);
    await writeFile(manifestPath, manifest);
  }
});
