import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertArtifactMetadata,
  buildPackage as buildProtocolPackage,
  computeSourceInputsDigest as computeProtocolSourceInputsDigest,
} from "../../connector-protocol/scripts/package-artifact.mjs";

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const metadataPath = join(packageRoot, "artifact.json");
const FIXED_INPUTS = ["README.md", "package.json", "scripts/build.ts", "tsconfig.build.json"];
const METADATA_VERSION = 1;
const protocolPackageRoot = resolve(packageRoot, "..", "connector-protocol");
const runtimePackageRelPath = relative(repoRoot, packageRoot);
const protocolPackageRelPath = relative(repoRoot, protocolPackageRoot);

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest("hex");
}

async function sourceInputPaths() {
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
          } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            paths.push(relative(packageRoot, fullPath));
          }
        })
    );
  };
  await visit(join(packageRoot, "src"));
  return [...FIXED_INPUTS, ...paths].sort((left, right) => left.localeCompare(right));
}

async function computeRuntimeSourceInputsDigest() {
  const entries = await Promise.all(
    (await sourceInputPaths()).map(async (inputPath) => ({
      path: inputPath,
      sha256: digest(await readFile(join(packageRoot, inputPath)), "sha256"),
    }))
  );
  return digest(JSON.stringify(entries), "sha256");
}

export async function computeClosedSourceInputs() {
  const [runtimeSourceInputsSha256, connectorProtocolSourceInputsSha256] = await Promise.all([
    computeRuntimeSourceInputsDigest(),
    computeProtocolSourceInputsDigest(),
  ]);
  return {
    connectorProtocolSourceInputsSha256,
    sourceInputsSha256: digest(
      JSON.stringify({ connectorProtocolSourceInputsSha256, runtimeSourceInputsSha256 }),
      "sha256"
    ),
  };
}

export async function computeSourceInputsDigest() {
  return (await computeClosedSourceInputs()).sourceInputsSha256;
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
      sha256: digest(await readFile(join(root, declarationPath)), "sha256"),
    }))
  );
  return digest(JSON.stringify(entries), "sha256");
}

export async function computeDeclarationDigest() {
  return await computeDeclarationDigestAt(packageRoot);
}

async function buildPackage(root) {
  await execFile("npm", ["run", "build"], { cwd: root });
}

async function protocolArtifactMetadata(root) {
  return JSON.parse(await readFile(join(root, "artifact.json"), "utf8"));
}

export function assertProtocolBuildMatchesReceipt(metadata, sourceInputsSha256, declarationsSha256) {
  if (metadata.source_inputs_sha256 !== sourceInputsSha256) {
    throw new Error(
      `connector-protocol source inputs drift: expected ${JSON.stringify(metadata.source_inputs_sha256)}, got ${JSON.stringify(sourceInputsSha256)}`
    );
  }
  if (metadata.declarations_sha256 !== declarationsSha256) {
    throw new Error(
      `connector-protocol declarations drift: expected ${JSON.stringify(metadata.declarations_sha256)}, got ${JSON.stringify(declarationsSha256)}`
    );
  }
}

export async function cloneCommittedSourceTree(ref = "HEAD") {
  const cloneDir = await mkdtemp(join(tmpdir(), "pdpp-collector-runtime-clone-"));
  const archivePath = join(cloneDir, "source.tar");
  await execFile(
    "git",
    ["archive", "--output", archivePath, ref, "--", runtimePackageRelPath, protocolPackageRelPath],
    { cwd: repoRoot }
  );
  await execFile("tar", ["-xf", archivePath, "-C", cloneDir]);
  await rm(archivePath, { force: true });
  const clonedRuntimeRoot = join(cloneDir, runtimePackageRelPath);
  const clonedProtocolRoot = join(cloneDir, protocolPackageRelPath);

  // The shared root node_modules supplies only the installed toolchain. The
  // runtime's nearest protocol dependency is an archived sibling, so neither
  // clone can resolve the workspace's ambient, untracked protocol dist.
  await symlink(join(repoRoot, "node_modules"), join(cloneDir, "node_modules"));
  const scopedDependencies = join(clonedRuntimeRoot, "node_modules", "@pdpp");
  await mkdir(scopedDependencies, { recursive: true });
  const clonedProtocolLink = join(scopedDependencies, "connector-protocol");
  await symlink(clonedProtocolRoot, clonedProtocolLink);
  if ((await realpath(clonedProtocolLink)) !== (await realpath(clonedProtocolRoot))) {
    throw new Error("collector-runtime clone did not resolve connector-protocol from its archived sibling");
  }
  return { cloneDir, clonedProtocolRoot, clonedRuntimeRoot };
}

async function packOnce(root) {
  const destination = await mkdtemp(join(tmpdir(), "pdpp-collector-runtime-pack-"));
  try {
    await execFile("npm", ["pack", "--pack-destination", destination, "--ignore-scripts"], { cwd: root });
    const produced = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
    if (produced.length !== 1) {
      throw new Error(`expected exactly one .tgz in ${destination}, found ${produced.length}`);
    }
    const [filename] = produced;
    const bytes = await readFile(join(destination, filename));
    return {
      filename,
      sha1: digest(bytes, "sha1"),
      sha256: digest(bytes, "sha256"),
      sha512: digest(bytes, "sha512"),
    };
  } finally {
    await rm(destination, { force: true, recursive: true });
  }
}

async function reproducibleArtifact() {
  const clones = [await cloneCommittedSourceTree(), await cloneCommittedSourceTree()];
  try {
    const protocolDeclarations = await Promise.all(
      clones.map(async ({ clonedProtocolRoot }) => {
        await buildProtocolPackage(clonedProtocolRoot);
        const [metadata, sourceInputsSha256, declarationsSha256] = await Promise.all([
          protocolArtifactMetadata(clonedProtocolRoot),
          computeProtocolSourceInputsDigest(clonedProtocolRoot),
          computeDeclarationDigestAt(clonedProtocolRoot),
        ]);
        assertProtocolBuildMatchesReceipt(metadata, sourceInputsSha256, declarationsSha256);
        return declarationsSha256;
      })
    );
    const [firstProtocolDeclarations, secondProtocolDeclarations] = protocolDeclarations;
    if (firstProtocolDeclarations !== secondProtocolDeclarations) {
      throw new Error(`connector-protocol declarations are not reproducible: ${JSON.stringify(protocolDeclarations)}`);
    }
    await Promise.all(clones.map(({ clonedRuntimeRoot }) => buildPackage(clonedRuntimeRoot)));
    const declarations = await Promise.all(
      clones.map(({ clonedRuntimeRoot }) => computeDeclarationDigestAt(clonedRuntimeRoot))
    );
    const [firstDeclaration, secondDeclaration] = declarations;
    if (firstDeclaration !== secondDeclaration) {
      throw new Error(`declaration output is not reproducible: ${JSON.stringify(declarations)}`);
    }
    const artifacts = await Promise.all(clones.map(({ clonedRuntimeRoot }) => packOnce(clonedRuntimeRoot)));
    const [firstArtifact, secondArtifact] = artifacts;
    if (JSON.stringify(firstArtifact) !== JSON.stringify(secondArtifact)) {
      throw new Error(`npm pack is not reproducible: ${JSON.stringify(artifacts)}`);
    }
    return {
      artifact: firstArtifact,
      connectorProtocolDeclarationsSha256: firstProtocolDeclarations,
      declarationsSha256: firstDeclaration,
    };
  } finally {
    await Promise.all(clones.map(({ cloneDir }) => rm(cloneDir, { force: true, recursive: true })));
  }
}

export async function generateArtifactMetadata() {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const { connectorProtocolSourceInputsSha256, sourceInputsSha256 } = await computeClosedSourceInputs();
  const { artifact, connectorProtocolDeclarationsSha256, declarationsSha256 } = await reproducibleArtifact();
  const metadata = {
    artifact_filename: artifact.filename,
    artifact_sha1: artifact.sha1,
    artifact_sha256: artifact.sha256,
    artifact_sha512: artifact.sha512,
    connector_protocol_declarations_sha256: connectorProtocolDeclarationsSha256,
    connector_protocol_source_inputs_sha256: connectorProtocolSourceInputsSha256,
    declarations_sha256: declarationsSha256,
    metadata_version: METADATA_VERSION,
    package_name: manifest.name,
    package_version: manifest.version,
    source_inputs_sha256: sourceInputsSha256,
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export async function verifyArtifactMetadata() {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const { connectorProtocolSourceInputsSha256, sourceInputsSha256 } = await computeClosedSourceInputs();
  const { artifact, connectorProtocolDeclarationsSha256, declarationsSha256 } = await reproducibleArtifact();
  assertArtifactMetadata(metadata, manifest, sourceInputsSha256, declarationsSha256, artifact);
  if (metadata.connector_protocol_source_inputs_sha256 !== connectorProtocolSourceInputsSha256) {
    throw new Error("artifact metadata drift in connector_protocol_source_inputs_sha256");
  }
  if (metadata.connector_protocol_declarations_sha256 !== connectorProtocolDeclarationsSha256) {
    throw new Error("artifact metadata drift in connector_protocol_declarations_sha256");
  }
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
  } else {
    console.error("usage: node scripts/package-artifact.mjs <generate|verify>");
    process.exitCode = 2;
  }
}
