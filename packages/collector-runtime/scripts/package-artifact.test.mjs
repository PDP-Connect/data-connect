import assert from "node:assert/strict";
import { appendFile, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertProtocolBuildMatchesReceipt,
  cloneCommittedSourceTree,
  computeSourceInputsDigest,
} from "./package-artifact.mjs";
import { computeSourceInputsDigest as computeProtocolSourceInputsDigest } from "../../connector-protocol/scripts/package-artifact.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolRoot = resolve(packageRoot, "..", "connector-protocol");
const protocolSourcePath = resolve(packageRoot, "..", "connector-protocol", "src", "auth.ts");

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
    /connector-protocol declarations drift/
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
