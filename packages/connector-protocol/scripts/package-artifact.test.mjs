import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertArtifactMetadata, computeDeclarationDigest, computeSourceInputsDigest } from "./package-artifact.mjs";

test("committed package artifact metadata is internally bound to current source inputs", async () => {
  const metadata = JSON.parse(await readFile(new URL("../artifact.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const sourceInputsSha256 = await computeSourceInputsDigest();
  const declarationsSha256 = await computeDeclarationDigest();

  assert.equal(metadata.package_name, manifest.name);
  assert.equal(metadata.package_version, manifest.version);
  assert.match(metadata.artifact_sha256, /^[0-9a-f]{64}$/);
  assert.match(sourceInputsSha256, /^[0-9a-f]{64}$/);
  assert.equal(metadata.declarations_sha256, declarationsSha256);
});

test("artifact metadata rejects a changed source digest", async () => {
  const metadata = JSON.parse(await readFile(new URL("../artifact.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const artifact = {
    filename: metadata.artifact_filename,
    sha256: metadata.artifact_sha256,
  };

  assert.throws(
    () => assertArtifactMetadata(metadata, manifest, "0".repeat(64), metadata.declarations_sha256, artifact),
    /source_inputs_sha256/
  );
});
