import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const CONNECTOR_ID = "github-pdpp";
const CONNECTOR_KEY = "github";
const ARTIFACT_KIND = "pdpp-collection-profile";

function fail(message) {
  throw new Error(`Invalid installed PDPP GitHub connector: ${message}`);
}
function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) fail(`${field} is required`);
  return value;
}

function confinedFile(root, relativePath, label) {
  requireString(relativePath, label);
  if (isAbsolute(relativePath)) fail(`${label} must be relative`);

  const path = resolve(root, relativePath);
  const escaped = relative(root, path).startsWith("..") || isAbsolute(relative(root, path));
  if (escaped) fail(`${label} escapes the install root`);
  if (!existsSync(path)) fail(`${label} is not accessible`);
  return path;
}

function verifyHash(path, expected, label) {
  requireString(expected, `${label} hash`);
  if (!expected.startsWith("sha256:")) fail(`${label} hash must be sha256`);
  const actual = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  if (actual !== expected) fail(`${label} hash does not match the active install`);
}

function validateManifest(install, manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("manifest must be an object");
  }
  if (manifest.connector_key !== CONNECTOR_KEY && manifest.connector_id !== CONNECTOR_ID) {
    fail("manifest identity does not match the active install");
  }
  if (manifest.version !== install.version) {
    fail(`manifest version ${String(manifest.version)} does not match active version ${install.version}`);
  }
  if (!Array.isArray(manifest.streams) || manifest.streams.length === 0) {
    fail("manifest must declare at least one stream");
  }
  const names = new Set();
  for (const stream of manifest.streams) {
    if (stream === null || typeof stream !== "object" || typeof stream.name !== "string" || stream.name.length === 0) {
      fail("manifest stream names must be non-empty strings");
    }
    if (!names.add(stream.name)) fail("manifest stream names must be unique");
  }
  const network = manifest.runtime_requirements?.bindings?.network;
  if (network?.required !== true) fail("manifest must require the network binding");
  for (const [binding, requirement] of Object.entries(manifest.runtime_requirements?.bindings ?? {})) {
    if (binding !== "network" && requirement?.required === true) {
      fail(`manifest requires unsupported binding ${binding}`);
    }
  }
}

/**
 * Load the manifest and provenance from the active, hash-verified install.
 * Consumers receive the artifact's values; they do not maintain a second
 * handwritten GitHub manifest or version constant.
 */
export function loadInstalledGithubManifest({
  activeManifestPath = join(homedir(), ".dataconnect", "connectors-active.json"),
  connectorId = CONNECTOR_ID,
} = {}) {
  if (connectorId !== CONNECTOR_ID) fail(`unsupported connector ${connectorId}`);

  const active = readJson(activeManifestPath, "active connector manifest");
  const install = active?.connectors?.[connectorId];
  if (install === null || typeof install !== "object") fail("active install is missing");
  if (install.artifactKind !== ARTIFACT_KIND) fail("active install is not a collection profile artifact");
  requireString(install.version, "active install version");

  const root = resolve(requireString(install.rootPath, "active install root"));
  const manifestPath = confinedFile(root, install.manifestPath, "manifest path");
  const entrypointPath = confinedFile(root, install.entrypointPath, "entrypoint path");
  const provenancePath = confinedFile(root, install.provenancePath, "provenance path");
  verifyHash(manifestPath, install.manifestSha256, "manifest");
  verifyHash(entrypointPath, install.entrypointSha256, "entrypoint");
  verifyHash(provenancePath, install.provenanceSha256, "provenance");

  const manifest = readJson(manifestPath, "manifest");
  validateManifest(install, manifest);
  const provenance = readJson(provenancePath, "provenance");

  return Object.freeze({
    connectorId,
    version: install.version,
    manifest,
    provenance,
    manifestPath,
    entrypointPath,
    provenancePath,
  });
}
