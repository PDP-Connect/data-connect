import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertArtifactMetadata,
  buildPackage,
  computeDeclarationDigest,
  computeSourceInputsDigest,
  verifyArtifactMetadata,
} from "./package-artifact.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageRoot, "dist");
const HEX_256 = /^[0-9a-f]{64}$/;
const HEX_512 = /^[0-9a-f]{128}$/;
const HEX_160 = /^[0-9a-f]{40}$/;
const SOURCE_INPUTS_ERROR = /source_inputs_sha256/;
const ARTIFACT_SOURCE_INPUTS_ERROR = /artifact metadata drift in source_inputs_sha256/;
const ARTIFACT_DECLARATIONS_ERROR = /artifact metadata drift in declarations_sha256/;

// `computeDeclarationDigest` reads from dist/**/*.d.ts. On a genuinely clean
// checkout, dist/ does not exist yet, so every test below that inspects
// declarations must build first — see the regression this closed: a clean
// checkout with no pre-existing dist/ failed `npm test` outright before this
// fix, confirmed under installed npm 12.0.2.
before(async () => {
  await buildPackage();
});

// The regression test below deletes this package's own dist/ to prove
// verifyArtifactMetadata works from a clean checkout; it never rebuilds
// packageRoot's own dist/ afterward (its clean-tree builds happen in
// separate temp clones — see reproducibleArtifact). Rebuild once more here
// so `npm test` leaves the working tree's dist/ present, matching state
// before this file ran, rather than a test suite silently deleting a build
// output other tooling (prepack, downstream vendoring builds) expects.
after(async () => {
  await buildPackage();
});

test("committed package artifact metadata is internally bound to current source inputs", async () => {
  const metadata = JSON.parse(await readFile(new URL("../artifact.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const sourceInputsSha256 = await computeSourceInputsDigest();
  const declarationsSha256 = await computeDeclarationDigest();

  assert.equal(metadata.package_name, manifest.name);
  assert.equal(metadata.package_version, manifest.version);
  assert.match(metadata.artifact_sha256, HEX_256);
  assert.match(sourceInputsSha256, HEX_256);
  // The committed digest must actually equal what a fresh computation
  // produces from the current source — not merely be well-formed hex. A
  // digest that is well-formed but stale (computed against different
  // source than what is currently checked in) would pass the old,
  // shape-only assertion silently.
  assert.equal(metadata.source_inputs_sha256, sourceInputsSha256);
  assert.equal(metadata.declarations_sha256, declarationsSha256);
});

test("artifact metadata rejects a changed source digest", async () => {
  const metadata = JSON.parse(await readFile(new URL("../artifact.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const artifact = {
    filename: metadata.artifact_filename,
    sha1: metadata.artifact_sha1,
    sha256: metadata.artifact_sha256,
    sha512: metadata.artifact_sha512,
  };

  assert.throws(
    () => assertArtifactMetadata(metadata, manifest, "0".repeat(64), metadata.declarations_sha256, artifact),
    SOURCE_INPUTS_ERROR
  );
});

test("artifact metadata rejects every mismatched identity or digest field", async () => {
  const metadata = JSON.parse(await readFile(new URL("../artifact.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const sourceInputsSha256 = await computeSourceInputsDigest();
  const declarationsSha256 = await computeDeclarationDigest();
  const artifact = {
    filename: metadata.artifact_filename,
    sha1: metadata.artifact_sha1,
    sha256: metadata.artifact_sha256,
    sha512: metadata.artifact_sha512,
  };
  const identityFields = [
    "artifact_filename",
    "artifact_sha256",
    "artifact_sha512",
    "artifact_sha1",
    "package_name",
    "package_version",
  ];

  for (const field of identityFields) {
    assert.throws(
      () =>
        assertArtifactMetadata(
          { ...metadata, [field]: `mismatched-${metadata[field]}` },
          manifest,
          sourceInputsSha256,
          declarationsSha256,
          artifact
        ),
      new RegExp(`artifact metadata drift in ${field}`)
    );
  }
  assert.throws(
    () => assertArtifactMetadata(metadata, manifest, `mismatched-${sourceInputsSha256}`, declarationsSha256, artifact),
    ARTIFACT_SOURCE_INPUTS_ERROR
  );
  assert.throws(
    () => assertArtifactMetadata(metadata, manifest, sourceInputsSha256, `mismatched-${declarationsSha256}`, artifact),
    ARTIFACT_DECLARATIONS_ERROR
  );
});

test("verifyArtifactMetadata succeeds against the real installed npm binary with dist/ absent beforehand", async () => {
  // Regression coverage for review finding #7: under installed npm 12.0.2,
  // `execFile("npm", ["pack", "--json", ...])` exits 0 but returns EMPTY
  // captured stdout, so `JSON.parse(stdout)` threw `Unexpected end of JSON
  // input`. This test runs the real, installed `npm` binary end to end
  // (nothing mocked) starting from a state where dist/ does not exist, and
  // asserts the full verify path (which itself does two independent
  // clean-tree builds and packs, see reproducibleArtifact) still produces
  // exactly one tarball per build with matching digests.
  //
  // Deliberately calls verifyArtifactMetadata, not generateArtifactMetadata:
  // generate WRITES the committed artifact.json, which would make this test
  // mutate a tracked file as a side effect of running `npm test`. verify is
  // read-only against the committed metadata and is sufficient to prove the
  // npm-pack-stdout regression stays fixed.
  await rm(distDir, { force: true, recursive: true });

  const verified = await verifyArtifactMetadata();
  assert.match(verified.artifact_sha256, HEX_256);
  assert.match(verified.artifact_sha512, HEX_512);
  assert.match(verified.artifact_sha1, HEX_160);
});
