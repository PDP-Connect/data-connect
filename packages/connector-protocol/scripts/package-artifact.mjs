import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath = join(packageRoot, "artifact.json");

const FIXED_INPUTS = ["README.md", "package.json", "scripts/build.ts", "tsconfig.build.json"];
const ARTIFACT_METADATA_VERSION = 1;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceInputPaths() {
  const sourcePaths = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        sourcePaths.push(relative(packageRoot, fullPath));
      }
    }
  };

  await visit(join(packageRoot, "src"));
  return [...FIXED_INPUTS, ...sourcePaths].sort((left, right) => left.localeCompare(right));
}

export async function computeSourceInputsDigest() {
  const entries = [];
  for (const inputPath of await sourceInputPaths()) {
    entries.push({
      path: inputPath,
      sha256: sha256(await readFile(join(packageRoot, inputPath))),
    });
  }
  return sha256(JSON.stringify(entries));
}

async function declarationPaths() {
  const paths = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.name.endsWith(".d.ts")) {
        paths.push(relative(packageRoot, fullPath));
      }
    }
  };

  await visit(join(packageRoot, "dist"));
  return paths.sort((left, right) => left.localeCompare(right));
}

export async function computeDeclarationDigest() {
  const entries = [];
  for (const declarationPath of await declarationPaths()) {
    entries.push({
      path: declarationPath,
      sha256: sha256(await readFile(join(packageRoot, declarationPath))),
    });
  }
  return sha256(JSON.stringify(entries));
}

async function readPackageManifest() {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
}

async function packOnce() {
  const destination = await mkdtemp(join(tmpdir(), "pdpp-connector-protocol-pack-"));
  try {
    const { stdout } = await execFile(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
      {
        cwd: packageRoot,
      }
    );
    const records = JSON.parse(stdout);
    const record = Array.isArray(records) ? records[0] : Object.values(records)[0];
    if (!record || typeof record.filename !== "string") {
      throw new Error("npm pack did not return exactly one artifact record");
    }
    const filename = record.filename;
    const bytes = await readFile(join(destination, filename));
    return { filename, sha256: sha256(bytes) };
  } finally {
    await rm(destination, { force: true, recursive: true });
  }
}

async function buildPackage() {
  await execFile("npm", ["run", "build"], { cwd: packageRoot });
}

export function assertArtifactMetadata(metadata, manifest, sourceInputsSha256, declarationsSha256, artifact) {
  const expected = {
    artifact_filename: artifact.filename,
    artifact_sha256: artifact.sha256,
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

async function reproducibleArtifact() {
  const first = await packOnce();
  const second = await packOnce();
  if (first.filename !== second.filename || first.sha256 !== second.sha256) {
    throw new Error(`npm pack is not reproducible: ${JSON.stringify({ first, second })}`);
  }
  return first;
}

export async function generateArtifactMetadata() {
  await buildPackage();
  const manifest = await readPackageManifest();
  const sourceInputsSha256 = await computeSourceInputsDigest();
  const declarationsSha256 = await computeDeclarationDigest();
  const artifact = await reproducibleArtifact();
  const metadata = {
    artifact_filename: artifact.filename,
    artifact_sha256: artifact.sha256,
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
  await buildPackage();
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const manifest = await readPackageManifest();
  const sourceInputsSha256 = await computeSourceInputsDigest();
  const declarationsSha256 = await computeDeclarationDigest();
  const artifact = await reproducibleArtifact();
  assertArtifactMetadata(metadata, manifest, sourceInputsSha256, declarationsSha256, artifact);
  return metadata;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const metadata =
    command === "generate"
      ? await generateArtifactMetadata()
      : command === "verify"
        ? await verifyArtifactMetadata()
        : null;
  if (!metadata) {
    console.error("usage: node scripts/package-artifact.mjs <generate|verify>");
    process.exitCode = 2;
  } else {
    console.log(`${command}: ${metadata.package_name}@${metadata.package_version}`);
    console.log(`artifact: ${metadata.artifact_filename}`);
    console.log(`sha256: ${metadata.artifact_sha256}`);
    console.log(`source inputs sha256: ${metadata.source_inputs_sha256}`);
    console.log(`declarations sha256: ${metadata.declarations_sha256}`);
  }
}
