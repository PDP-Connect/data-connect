#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

# Re-point the paired data-connectors #92 re-vendor after upstream merges.
# Run with Node 24 on PATH: upstream's build and this repo's CI checks now share it.
# Set REVENDOR_HOST_NODE_BIN to the Node 24.14.1 bin directory for host npm commands.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ! $1 =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <full-upstream-commit-sha> [data-connectors-repo]" >&2
  exit 1
fi

pin_sha=$1
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
upstream_repo=${2:-"$repo_root/../data-connectors"}
upstream_repo=$(cd "$upstream_repo" && pwd)
git -C "$upstream_repo" cat-file -e "$pin_sha^{commit}"
mkdir -p "$HOME/.tmp"
scratch=$(mktemp -d "$HOME/.tmp/data-connect-revendor.XXXXXX")
upstream_worktree="$scratch/upstream"
cleanup() {
  if [[ -d "$upstream_worktree" ]]; then
    git -C "$upstream_repo" worktree remove --force "$upstream_worktree"
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
git -C "$upstream_repo" worktree add --detach "$upstream_worktree" "$pin_sha"

export TMPDIR="$scratch"
export PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
(
  cd "$upstream_worktree/packages/polyfill-connectors"
  npm ci --ignore-scripts
  npm run generate:connector-index
  npm pack --pack-destination "$scratch"
)

mkdir "$scratch/repack"
tar -xzf "$scratch/pdpp-polyfill-connectors-0.0.1.tgz" -C "$scratch/repack"
node --input-type=module - "$scratch/repack/package/package.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const pkg = JSON.parse(readFileSync(file, "utf8"));
for (const name of ["@pdpp/collector-runtime", "@pdpp/connector-protocol", "@pdpp/reference-contract"]) {
  pkg.dependencies[name] = "*";
  if (pkg.devDependencies) delete pkg.devDependencies[name];
}
delete pkg.bundledDependencies;
delete pkg.bundleDependencies;
if (pkg.overrides?.["@pdpp/collector-runtime"]) {
  for (const name of ["@pdpp/connector-protocol", "@pdpp/reference-contract"]) {
    pkg.overrides["@pdpp/collector-runtime"][name] = "*";
  }
}
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
NODE
rm -rf "$scratch/repack/package/vendor" "$scratch/repack/package/node_modules"
cd "$repo_root"
if [[ -n ${REVENDOR_HOST_NODE_BIN:-} ]]; then
  export PATH="$REVENDOR_HOST_NODE_BIN:$PATH"
fi
artifact=reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz
tar -czf "$repo_root/$artifact" -C "$scratch/repack" package

node --input-type=module - "$artifact" <<'NODE'
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const artifact = process.argv[2];
const sums = join(dirname(artifact), "SHA256SUMS");
const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
const lines = readFileSync(sums, "utf8").trimEnd().split("\n");
const index = lines.findIndex((line) => line.trim().endsWith(basename(artifact)));
if (index < 0) throw new Error("Missing polyfill-connectors checksum entry");
lines[index] = `${digest}  ${basename(artifact)}`;
writeFileSync(sums, `${lines.join("\n")}\n`);
NODE

# These are the connector sources and shared cursor changed by upstream #92.
for connector in claude_code codex; do
  for file in index.ts types.ts; do
    source_path="packages/polyfill-connectors/connectors/$connector/$file"
    git -C "$upstream_repo" show "$pin_sha:$source_path" > "$source_path"
  done
done
source_path="packages/polyfill-connectors/src/local-jsonl-cursor.ts"
git -C "$upstream_repo" show "$pin_sha:$source_path" > "$source_path"

# Replacing a file tarball at the same path requires clearing npm's old integrity.
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = "package-lock.json";
const lock = JSON.parse(readFileSync(file, "utf8"));
for (const key of Object.keys(lock.packages)) {
  if (key.endsWith("node_modules/@pdpp/polyfill-connectors")) delete lock.packages[key];
}
writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
NODE
npm install --package-lock-only --ignore-scripts
npm ci
npm --prefix reference-implementation run generate:connector-registry

node --input-type=module - "$pin_sha" <<'NODE'
import { appendFileSync } from "node:fs";
const sha = process.argv[2];
const date = new Date().toISOString().slice(0, 10);
appendFileSync("reference-implementation/vendor/README.md",
  `\n**Update (${date}): pin moved to data-connectors commit \`${sha}\`.**\n` +
  "Rebuilt with `scripts/revendor-polyfill-connectors.sh` for the malformed-line\n" +
  "isolation fix in data-connectors#92. The upstream connector index is regenerated\n" +
  "before packing; host-provided dependencies and bundled local collector sources\n" +
  "are updated using the same post-pack procedure above.\n");
NODE
echo "Re-vendored $pin_sha. Run the RI typecheck and suite with CI's Node 24.14.1."
