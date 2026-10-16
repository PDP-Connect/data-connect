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

files=(
  scripts/generate-mcp-existing-client-contract.ts
  test/README.md
  test/fixtures/mcp-existing-client-contract.json
  test/fixtures/mcp-existing-client-gate-inventory.json
  test/helpers/mcp-existing-client-session.ts
  test/mcp-existing-client-audience-migration.test.ts
  test/mcp-existing-client-gate.test.ts
  test/mcp-stored-id-resolution.test.ts
  test/scripts/run-mcp-existing-client-gate.mjs
  test/scripts/seed-mcp-audience-migration-fixture.ts
)
for relative in "${files[@]}"; do
  mkdir -p "$target_ref/$(dirname "$relative")"
  cp "$source_ref/$relative" "$target_ref/$relative"
done

node - "$target_ref/package.json" <<'NODE'
const fs = require("node:fs")
const path = process.argv[2]
const text = fs.readFileSync(path, "utf8")
const testScript = /^(\s*)"test":\s*.*,$/m
let updated = text
if (!testScript.test(updated)) throw new Error("could not find the reference implementation test script")
for (const [name, command] of [
  ["test:mcp-existing-client-gate", "node test/scripts/run-mcp-existing-client-gate.mjs"],
  ["refresh:mcp-existing-client-contract", "node --import tsx scripts/generate-mcp-existing-client-contract.ts && prettier --write test/fixtures/mcp-existing-client-contract.json"],
]) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const existing = new RegExp(`^(\\s*)"${escapedName}":\\s*"[^"]*",?$`, "m")
  if (existing.test(updated)) updated = updated.replace(existing, (_line, indent) => `${indent}"${name}": "${command}",`)
  else updated = updated.replace(testScript, (line, indent) => `${indent}"${name}": "${command}",\n${line}`)
}
fs.writeFileSync(path, updated)
NODE

echo "Applied the MCP existing-client gate to $target"
