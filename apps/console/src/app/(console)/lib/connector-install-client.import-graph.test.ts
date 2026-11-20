// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The staged-console probe (scripts/check-staged-console-connectors.mjs)
// evaluates every webpack module whose text names the conformance roster
// package. Webpack concatenates a module into its importer, so any module the
// owner-token client reaches that also reaches polyfill-connectors-runtime can
// land in that set. The client imports owner-token (next/headers); the probe
// loads only `.next/server/chunks`, where next/headers' externals are absent,
// so evaluating it throws "e[a] is not a function" and every desktop build
// fails. The client therefore must not reach the shared setup planner.
const LIB_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN_SPECIFIERS = [
  "pdpp-reference-implementation/connection-setup-plan",
  "polyfill-connectors-runtime",
  "@pdpp/polyfill-connectors",
];

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");
}

/** Every module reachable from `entry` by relative imports, with the chain that reached a forbidden one. */
function forbiddenChains(entry: string): string[] {
  const chains: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string, chain: readonly string[]) => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (FORBIDDEN_SPECIFIERS.some((forbidden) => specifier.includes(forbidden))) {
        chains.push([...chain, specifier].join(" -> "));
      } else if (specifier.startsWith(".")) {
        const next = join(dirname(file), specifier);
        if (existsSync(next)) {
          visit(next, [...chain, specifier]);
        }
      }
    }
  };
  visit(join(LIB_DIRECTORY, entry), [entry]);
  return chains;
}

test("the owner-token install client does not reach the shared setup planner or the connector package", () => {
  assert.deepEqual(forbiddenChains("connector-install-client.ts"), []);
});
