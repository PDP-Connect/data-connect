// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const metadataPath = join(packageRoot, "artifact.json");

const FIXED_INPUTS = ["README.md", "package.json", "scripts/build.ts", "tsconfig.build.json"];
const ARTIFACT_METADATA_VERSION = 1;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512(bytes) {
  return createHash("sha512").update(bytes).digest("hex");
}

function sha1(bytes) {
  return createHash("sha1").update(bytes).digest("hex");
}

async function sourceInputPaths(root = packageRoot) {
  const sourcePaths = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => {
          const fullPath = join(directory, entry.name);
          if (entry.isDirectory()) {
            await visit(fullPath);
          } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            sourcePaths.push(relative(root, fullPath));
          }
        })
    );
  };

  await visit(join(root, "src"));
  return [...FIXED_INPUTS, ...sourcePaths].sort((left, right) => left.localeCompare(right));
}

export async function computeSourceInputsDigest(root = packageRoot) {
  const entries = await Promise.all(
    (await sourceInputPaths(root)).map(async (inputPath) => ({
      path: inputPath,
      sha256: sha256(await readFile(join(root, inputPath))),
    }))
  );
  return sha256(JSON.stringify(entries));
}

async function declarationPaths(root) {
  const paths = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => {
          const fullPath = join(directory, entry.name);
          if (entry.isDirectory()) {
            await visit(fullPath);
          } else if (entry.name.endsWith(".d.ts")) {
            paths.push(relative(root, fullPath));
          }
        })
    );
  };

  await visit(join(root, "dist"));
  return paths.sort((left, right) => left.localeCompare(right));
}

async function computeDeclarationDigestAt(root) {
  const entries = await Promise.all(
    (await declarationPaths(root)).map(async (declarationPath) => ({
      path: declarationPath,
      sha256: sha256(await readFile(join(root, declarationPath))),
    }))
  );
  return sha256(JSON.stringify(entries));
}

export async function computeDeclarationDigest() {
  return await computeDeclarationDigestAt(packageRoot);
}

async function readPackageManifest() {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
}

/**
 * Builds the package's `dist/` from source. Exported so both this module's
 * own generate/verify paths and `package-artifact.test.mjs` build the same
 * way — a test that reads `dist/**\/*.d.ts` without building it first passes
 * only by accident of a leftover build from a prior command, and fails on a
 * genuinely clean checkout (see the regression this closed: `npm test` on a
 * clean checkout with no pre-existing `dist/`).
 */
export async function buildPackage(root = packageRoot) {
  await execFile("npm", ["run", "build"], { cwd: root });
}

/**
 * Creates an independent clean-tree copy of this package's committed source
 * at the given ref (defaults to HEAD) in a fresh temporary directory, with
 * `node_modules` symlinked in so the copy's own `npm run build` can resolve
 * `typescript`/`zod`/etc without a second `npm install`.
 *
 * `git archive` (not `git worktree add`) is the deliberate choice here: a
 * worktree shares this repo's `.git` and is meant for checked-out, editable
 * work; an archive is a plain read-only snapshot of tracked, committed
 * content, which is exactly what a "clean tree at this commit" build needs
 * and nothing more. Each call returns its own directory — two calls produce
 * two independent trees, each getting its own `dist/` from its own `npm run
 * build` invocation, never sharing a `dist/` with the other or with this
 * package's own working-tree `dist/`.
 */
async function cloneCommittedSourceTree(ref = "HEAD") {
  const cloneDir = await mkdtemp(join(tmpdir(), "pdpp-connector-protocol-clone-"));
  const packageRelPath = relative(repoRoot, packageRoot);
  const archivePath = join(cloneDir, "source.tar");
  // Write the archive to a file rather than piping git archive's stdout
  // straight into tar's stdin: with a promisified execFile, piping a large
  // buffer through the `input` option to a second execFile call is prone to
  // hanging (no consumer draining the child's stdout fast enough while its
  // stdin is still being written). A temp file avoids that pipe entirely.
  await execFile("git", ["archive", "--output", archivePath, ref, "--", packageRelPath], {
    cwd: repoRoot,
  });
  await execFile("tar", ["-xf", archivePath, "-C", cloneDir]);
  await rm(archivePath, { force: true });
  const clonedPackageRoot = join(cloneDir, packageRelPath);
  // node_modules is untracked (not part of what `git archive` extracts), so
  // resolving the build toolchain (typescript, zod, etc.) needs this
  // symlink back to the already-installed real node_modules. This does not
  // weaken the reproducibility check: what is being proven reproducible is
  // the SOURCE -> dist -> tarball transform, run twice independently: never
  // reusing a dist/ or a tarball between the two builds. The toolchain
  // itself is the same fixed input either way a normal `npm install` would
  // produce it.
  await symlink(join(packageRoot, "node_modules"), join(clonedPackageRoot, "node_modules"));
  // This npm workspace HOISTS shared devDependencies: `@types/node` lives
  // only at the real repo root's node_modules/@types/node, not inside this
  // package's own node_modules/@types (which is empty). TypeScript's default
  // @types auto-inclusion resolves by walking up parent directories looking
  // for node_modules/@types; in the real repo that walk reaches the repo
  // root and finds it, but in this isolated clone tree there is no repo
  // root above the clone to walk up to, so the walk fails with `TS2688:
  // Cannot find type definition file for 'node'`. Symlinking a second
  // node_modules at the CLONE TREE'S OWN ROOT (standing in for the repo
  // root) — not inside clonedPackageRoot — replicates the real repo's shape:
  // clonedPackageRoot sits at the same relative depth beneath cloneDir
  // (packages/connector-protocol) as packageRoot does beneath repoRoot, so
  // the ancestor walk from the cloned package finds the hoisted
  // @types/node at the same relative depth it would in the real repo. Kept
  // alongside the package-local symlink above (not replacing it): the
  // package-local one may resolve some packages faster/differently, and
  // removing it could change other behavior.
  await symlink(join(repoRoot, "node_modules"), join(cloneDir, "node_modules"));
  return { cloneDir, clonedPackageRoot };
}

/**
 * Packs an already-built package root into a fresh, empty destination
 * directory and returns the resulting tarball's filename plus its sha256,
 * sha512, and sha1 digests, computed locally from the tarball's own bytes.
 *
 * Deliberately does NOT parse `npm pack --json`'s stdout: under installed
 * npm 12.0.2, `execFile("npm", ["pack", "--json", ...])` exits 0 but returns
 * an EMPTY captured stdout, so `JSON.parse(stdout)` throws `Unexpected end
 * of JSON input` (confirmed by direct reproduction against the real
 * installed npm binary, not a mocked one). Instead: pack without `--json`
 * into a destination this function first creates empty, then read that
 * directory back with `readdir` and require it holds EXACTLY one `.tgz` —
 * never guess which file is "the" artifact.
 */
async function packOnce(root) {
  const destination = await mkdtemp(join(tmpdir(), "pdpp-connector-protocol-pack-"));
  try {
    const existingBefore = await readdir(destination);
    if (existingBefore.length !== 0) {
      throw new Error(`pack destination ${destination} was not empty before packing`);
    }
    await execFile("npm", ["pack", "--pack-destination", destination, "--ignore-scripts"], {
      cwd: root,
    });
    const produced = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
    if (produced.length !== 1) {
      throw new Error(
        `expected exactly one .tgz in ${destination} after npm pack, found ${produced.length}: ${JSON.stringify(produced)}`
      );
    }
    const [filename] = produced;
    const bytes = await readFile(join(destination, filename));
    return {
      filename,
      sha1: sha1(bytes),
      sha256: sha256(bytes),
      sha512: sha512(bytes),
    };
  } finally {
    await rm(destination, { force: true, recursive: true });
  }
}

export function assertArtifactMetadata(metadata, manifest, sourceInputsSha256, declarationsSha256, artifact) {
  const expected = {
    artifact_filename: artifact.filename,
    artifact_sha1: artifact.sha1,
    artifact_sha256: artifact.sha256,
    artifact_sha512: artifact.sha512,
    declarations_sha256: declarationsSha256,
    package_name: manifest.name,
    package_version: manifest.version,
    source_inputs_sha256: sourceInputsSha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) {
      throw new Error(
        `artifact metadata drift in ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(metadata[key])}`
      );
    }
  }
  if (metadata.metadata_version !== ARTIFACT_METADATA_VERSION) {
    throw new Error(`unsupported artifact metadata version: ${String(metadata.metadata_version)}`);
  }
}

/**
 * Proves independent-build reproducibility, not merely npm-pack determinism:
 * two SEPARATE clean-tree clones of the committed source (see
 * `cloneCommittedSourceTree`), each built with its own `npm run build` into
 * its own `dist/`, each packed into its own empty destination. If the
 * resulting declaration digest and tarball digest match across both
 * independent builds, the artifact is reproducible from source — not just
 * "packing the same already-built dist/ twice produces the same tarball,"
 * which is a strictly weaker (and, on its own, misleading) claim.
 */
async function reproducibleArtifact() {
  const clones = [await cloneCommittedSourceTree(), await cloneCommittedSourceTree()];
  try {
    const [firstClone, secondClone] = clones;
    await buildPackage(firstClone.clonedPackageRoot);
    await buildPackage(secondClone.clonedPackageRoot);
    const [firstDeclarations, secondDeclarations] = await Promise.all([
      computeDeclarationDigestAt(firstClone.clonedPackageRoot),
      computeDeclarationDigestAt(secondClone.clonedPackageRoot),
    ]);
    if (firstDeclarations !== secondDeclarations) {
      throw new Error(
        `declaration output is not reproducible across two independent clean-tree builds: ${JSON.stringify({ firstDeclarations, secondDeclarations })}`
      );
    }
    const first = await packOnce(firstClone.clonedPackageRoot);
    const second = await packOnce(secondClone.clonedPackageRoot);
    if (
      first.filename !== second.filename ||
      first.sha256 !== second.sha256 ||
      first.sha512 !== second.sha512 ||
      first.sha1 !== second.sha1
    ) {
      throw new Error(
        `npm pack is not reproducible across two independent clean-tree builds: ${JSON.stringify({ first, second })}`
      );
    }
    return { artifact: first, declarationsSha256: firstDeclarations };
  } finally {
    await Promise.all(clones.map((clone) => rm(clone.cloneDir, { force: true, recursive: true })));
  }
}

export async function generateArtifactMetadata() {
  const manifest = await readPackageManifest();
  const sourceInputsSha256 = await computeSourceInputsDigest();
  const { artifact, declarationsSha256 } = await reproducibleArtifact();
  const metadata = {
    artifact_filename: artifact.filename,
    artifact_sha1: artifact.sha1,
    artifact_sha256: artifact.sha256,
    artifact_sha512: artifact.sha512,
    declarations_sha256: declarationsSha256,
    metadata_version: ARTIFACT_METADATA_VERSION,
    package_name: manifest.name,
    package_version: manifest.version,
    source_inputs_sha256: sourceInputsSha256,
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export async function verifyArtifactMetadata() {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const manifest = await readPackageManifest();
  const sourceInputsSha256 = await computeSourceInputsDigest();
  const { artifact, declarationsSha256 } = await reproducibleArtifact();
  assertArtifactMetadata(metadata, manifest, sourceInputsSha256, declarationsSha256, artifact);
  return metadata;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [, , command] = process.argv;
  let metadata = null;
  if (command === "generate") {
    metadata = await generateArtifactMetadata();
  } else if (command === "verify") {
    metadata = await verifyArtifactMetadata();
  }
  if (metadata) {
    console.log(`${command}: ${metadata.package_name}@${metadata.package_version}`);
    console.log(`artifact: ${metadata.artifact_filename}`);
    console.log(`sha256: ${metadata.artifact_sha256}`);
    console.log(`sha512: ${metadata.artifact_sha512}`);
    console.log(`sha1: ${metadata.artifact_sha1}`);
    console.log(`source inputs sha256: ${metadata.source_inputs_sha256}`);
    console.log(`declarations sha256: ${metadata.declarations_sha256}`);
    // The Git commit SHA that produced this artifact is intentionally NOT
    // recorded here or in the committed artifact.json: an ordinary commit
    // cannot contain its own SHA without invalidating itself (the commit's
    // hash is a function of its own tree, which would have to include the
    // very field claiming to describe it). That provenance is real only
    // once the commit exists, i.e. at release time — via npm provenance,
    // not via scripts/semantic-release-github-output.ts (that script only
    // emits new-release-published/version/git-tag/major-minor as GitHub
    // Actions outputs; it does not bind anything to the published tarball).
    // The actual mechanism: packages/connector-protocol/package.json's
    // publishConfig.provenance: true, combined with
    // .github/workflows/npm-release.yml's `release` job publishing over
    // OIDC (id-token: write, no NPM_TOKEN), makes `@semantic-release/npm`
    // request a signed Sigstore attestation binding the published tarball's
    // exact contents (its integrity hash) to the exact GitHub Actions
    // workflow run that published it — which is itself bound to the exact
    // commit SHA (`github.sha`) that triggered the run. This is
    // independently verifiable after publish via
    // `npm view @pdpp/connector-protocol --json` (look for a
    // `dist.attestations` / provenance field) or `gh attestation verify`
    // against the downloaded tarball. See the `verify provenance` step in
    // npm-release.yml's `release` job for an automated check of this.
  } else {
    console.error("usage: node scripts/package-artifact.mjs <generate|verify>");
    process.exitCode = 2;
  }
}
