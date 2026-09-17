#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rewrite `tsconfig.build.json`'s shared-connector-source entries from the
 * connectors' own import graph.
 *
 * This is the writer for what `test/derive-connector-sources.test.ts` asserts.
 * Run it after vendoring a connector change; it edits only the
 * `../polyfill-connectors/src/...` lines in the `include` array, leaving the
 * surrounding comments and every other entry untouched, so the file stays the
 * commented JSONC a reader expects.
 *
 * It reports an unresolved import instead of writing: a specifier naming a file
 * this checkout does not have means the fix is to vendor that module, not to
 * record a list that omits it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveConnectorSources } from "./derive-connector-sources.ts";
import { LOCAL_COLLECTOR_DEFINITIONS } from "../src/generated/collector-definitions.generated.ts";

const tsconfigPath = fileURLToPath(new URL("../tsconfig.build.json", import.meta.url));

const entries = LOCAL_COLLECTOR_DEFINITIONS.map((definition) => definition.entry);
const { tsconfigIncludes, unresolved } = deriveConnectorSources(entries);

if (unresolved.length > 0) {
  console.error("FAIL: a bundled connector imports a relative path this checkout does not have.");
  for (const { from, specifier } of unresolved) {
    console.error(`  ${from} -> ${specifier}`);
  }
  console.error("Vendor the named module from data-connectors at the pinned commit, then re-run.");
  process.exit(1);
}

const text = readFileSync(tsconfigPath, "utf8");
const lines = text.split("\n");

const isSrcEntry = (line: string) => /^\s*"\.\.\/polyfill-connectors\/src\/[^"]+\.ts",?\s*$/.test(line);
const first = lines.findIndex(isSrcEntry);

if (first < 0) {
  console.error(`FAIL: found no ../polyfill-connectors/src/ entries in ${tsconfigPath}.`);
  process.exit(1);
}

let last = first;
while (last + 1 < lines.length && isSrcEntry(lines[last + 1])) last += 1;

// Preserve the trailing comma of the block exactly as it was: whether the last
// src entry is followed by another include entry is not this script's business.
const hadTrailingComma = lines[last].trimEnd().endsWith(",");
const indent = lines[first].slice(0, lines[first].search(/\S/));
const rewritten = tsconfigIncludes.map((f, i) => {
  const comma = i < tsconfigIncludes.length - 1 || hadTrailingComma ? "," : "";
  return `${indent}"${f}"${comma}`;
});

const next = [...lines.slice(0, first), ...rewritten, ...lines.slice(last + 1)].join("\n");

if (next === text) {
  console.log(`OK: tsconfig.build.json already lists the ${tsconfigIncludes.length} derived shared modules.`);
} else {
  writeFileSync(tsconfigPath, next);
  console.log(`Wrote ${tsconfigIncludes.length} derived shared modules into tsconfig.build.json.`);
}
