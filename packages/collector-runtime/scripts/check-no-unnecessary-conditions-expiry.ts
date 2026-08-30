#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Expiry check for the package-wide `noUnnecessaryConditions: "off"` policy
 * in biome.jsonc.
 *
 * That policy exists because Biome 2.5.5's noUnnecessaryConditions rule has
 * a confirmed false-positive: it claims `record[key] ?? fallback` /
 * `record[key]?.method()` is dead code even when TypeScript's
 * `noUncheckedIndexedAccess` makes the indexed value genuinely undefined.
 *
 * This script re-runs that exact minimal repro against whatever Biome
 * version is currently installed. If Biome no longer flags it, the bug is
 * fixed upstream: the blanket "off" is stale and must be replaced with a
 * real per-site audit (this script's own exit code drives that decision;
 * see the biome.jsonc comment for the audit procedure).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Walk up from `startDir` looking for `node_modules/.bin/biome`. npm
 * workspaces hoist `@biomejs/biome` to the monorepo root, so it is never
 * present directly under this package's own `node_modules` — only an
 * ancestor's.
 */
function resolveBiomeBinary(startDir: string): string | null {
  let cursor = resolve(startDir);
  const seen = new Set<string>();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const candidate = join(cursor, "node_modules", ".bin", "biome");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

const BIOME_BIN = resolveBiomeBinary(PACKAGE_ROOT);

const REPRO_SOURCE = `
function contentType(headers: Record<string, string>): string {
  return headers["content-type"]?.toLowerCase() ?? "";
}
export { contentType };
`;

const REPRO_CONFIG = JSON.stringify({
  $schema: "./node_modules/@biomejs/biome/configuration_schema.json",
  linter: {
    rules: {
      suspicious: {
        noUnnecessaryConditions: "error",
      },
    },
  },
});

function main(): void {
  if (!BIOME_BIN) {
    console.error(
      "[check-noUnnecessaryConditions-expiry] Could not locate a biome binary in this package's " +
        "node_modules or any ancestor's. Run `npm install` at the monorepo root before verifying."
    );
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "pdpp-biome-nuc-expiry-"));
  try {
    writeFileSync(join(dir, "biome.jsonc"), REPRO_CONFIG);
    writeFileSync(join(dir, "repro.ts"), REPRO_SOURCE);
    let output = "";
    try {
      output = execFileSync(BIOME_BIN, ["check", "repro.ts", "--only=suspicious/noUnnecessaryConditions"], {
        cwd: dir,
        stdio: "pipe",
      }).toString();
      // Exit 0: Biome found nothing wrong. Fall through to the text check
      // below anyway — belt and suspenders.
    } catch (err) {
      // --only restricts the run to exactly this rule, so ANY non-zero exit
      // here is that rule firing (or a genuine invocation failure, which the
      // text check below will fail to match and correctly report as fixed
      // rather than mask as "still buggy").
      const asExecError = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
      output = `${asExecError.stdout?.toString() ?? ""}${asExecError.stderr?.toString() ?? ""}`;
    }
    const stillBuggy = output.includes("noUnnecessaryConditions");
    if (stillBuggy) {
      console.log(
        "[check-noUnnecessaryConditions-expiry] Biome still reproduces the false positive; the biome.jsonc override remains justified."
      );
      return;
    }
    console.error(
      "[check-noUnnecessaryConditions-expiry] Biome no longer flags the readonly-nullable-field repro. " +
        'The noUnnecessaryConditions: "off" policy in biome.jsonc is STALE. ' +
        "Re-enable the rule, re-run `pnpm exec biome check .`, and re-audit each finding " +
        "(most were confirmed genuine false positives in 2026-07; a few may now resolve to real findings)."
    );
    process.exit(1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

main();
