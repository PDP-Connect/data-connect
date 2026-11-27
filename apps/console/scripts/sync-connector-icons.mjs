// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeSvg } from "@pdpp/brand-react/sanitize-svg";
import { assertIconCorpusConsistent } from "../src/app/(console)/lib/connector-icon-corpus-checks.ts";

const REPOSITORY = "PDP-Connect/data-connectors";
const REVISION = "23aee3aaeafad3a804d504e8614763f7845add60";
// Intentional tripwire: a connector gaining or losing a declared icon changes
// the shipped bundle, so the pinned count is bumped together with REVISION.
const EXPECTED_ASSETS = 65;
const MANIFEST_PATH = /^connectors\/[^/]+\/manifest\.json$/u;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(SCRIPT_DIR, "..");
const LIB_DIR = path.join(CONSOLE_DIR, "src/app/(console)/lib/connector-icons");
const PUBLIC_DIR = path.join(CONSOLE_DIR, "public/connector-icons");
const checkOnly = process.argv.includes("--check");
const sourceRepo = process.argv.slice(2).find((arg) => arg !== "--check");

if (!sourceRepo) {
  throw new Error("Pass the existing local data-connectors repository path; this script does not clone or fetch.");
}

function git(...args) {
  return execFileSync("git", ["-C", sourceRepo, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
}

if (git("rev-parse", `${REVISION}^{commit}`).trim() !== REVISION) {
  throw new Error(`Local ${REPOSITORY} repository does not contain pinned revision ${REVISION}.`);
}

const manifestPaths = git("ls-tree", "-r", "--name-only", REVISION, "--", "connectors/")
  .split("\n")
  .filter((file) => MANIFEST_PATH.test(file));
const entries = [];
for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(git("show", `${REVISION}:${manifestPath}`));
  const iconPath = manifest.brand?.icon;
  if (typeof iconPath !== "string" || !iconPath.trim()) {
    continue;
  }
  const parts = iconPath.split("/");
  if (
    iconPath.startsWith("/") ||
    iconPath.includes("\\") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe declared icon path in ${manifestPath}.`);
  }
  const sourcePath = path.posix.join(path.posix.dirname(manifestPath), iconPath);
  const svg = git("show", `${REVISION}:${sourcePath}`).trim();
  if (sanitizeSvg(svg) !== svg) {
    throw new Error(`Declared SVG failed the console allowlist: ${sourcePath}.`);
  }
  if (typeof manifest.connector_key !== "string" || typeof manifest.connector_id !== "string") {
    throw new Error(`Manifest identity is incomplete: ${manifestPath}.`);
  }
  entries.push({
    background_color: manifest.brand.background_color,
    connector_key: manifest.connector_key,
    connector_id: manifest.connector_id,
    display_name: manifest.display_name ?? manifest.source?.display?.name ?? manifest.connector_key,
    path: sourcePath,
    source_id: manifest.source?.id ?? null,
    svg,
  });
}
entries.sort((left, right) => {
  if (left.connector_key === right.connector_key) {
    return 0;
  }
  return left.connector_key < right.connector_key ? -1 : 1;
});
// The runtime indexes marks by every spelling of an identity, so a repeated or
// colliding identity, a free-form background, or a source whose entries
// disagree would make the shipped mark depend on file order.
assertIconCorpusConsistent(entries);
if (entries.length !== EXPECTED_ASSETS) {
  throw new Error(`Pinned source produced ${entries.length} icon assets; expected ${EXPECTED_ASSETS}.`);
}
const serialized = `${JSON.stringify({ repo: REPOSITORY, revision: REVISION, entries }, null, 2)}\n`;
const notice = git("show", `${REVISION}:NOTICE`);
const provenance = `# Connector icon provenance\n\nThe console bundle uses the manifest-declared SVG files from\n[${REPOSITORY}](https://github.com/${REPOSITORY})\nrevision \`${REVISION}\`. Their connector keys, canonical IDs, source paths, and SVG markup are recorded in the generated\n\`sanitized-assets.json\` bundle under the console library. The bundle is checked\nwith the console SVG allowlist before it reaches the shared icon renderer.\n\nSee [NOTICE](./NOTICE) for attribution and trademark terms.\n`;
const outputs = [
  [path.join(LIB_DIR, "sanitized-assets.json"), serialized],
  [path.join(LIB_DIR, "NOTICE"), notice],
  [path.join(PUBLIC_DIR, "NOTICE"), notice],
  [path.join(PUBLIC_DIR, "PROVENANCE.md"), provenance],
];
if (checkOnly) {
  for (const [file, expected] of outputs) {
    if (readFileSync(file, "utf8") !== expected) {
      throw new Error(`Generated icon output differs: ${file}. Run this script without --check to refresh it.`);
    }
  }
  process.stdout.write(`Verified ${entries.length} icons from ${REVISION}.\n`);
} else {
  for (const [file, contents] of outputs) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  process.stdout.write(`Wrote ${entries.length} icons from ${REVISION}.\n`);
}
