#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <candidate-worktree>" >&2
  exit 2
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_root=$(cd "$script_dir/../../.." && pwd)
target=$(git -C "$1" rev-parse --show-toplevel)
source_ref="$source_root/reference-implementation"
target_ref="$target/reference-implementation"
if [[ ! -f "$target_ref/package.json" ]]; then
  echo "candidate worktree has no reference-implementation/package.json: $target" >&2
  exit 2
fi

node --input-type=module - "$source_ref" "$target_ref" <<'NODE'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
const [source, target] = process.argv.slice(2)
const { MCP_GATE_OVERLAY_FILES, MCP_GATE_SCRIPTS } = await import(pathToFileURL(join(source, "test/helpers/mcp-existing-client-provenance.ts")))
for (const relative of MCP_GATE_OVERLAY_FILES) {
  const destination = join(target, relative)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(join(source, relative), destination)
}
const path = join(target, "package.json")
const pkg = JSON.parse(readFileSync(path, "utf8"))
Object.assign(pkg.scripts, MCP_GATE_SCRIPTS)
writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
NODE

echo "Applied the MCP existing-client gate to $target"
