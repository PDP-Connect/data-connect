// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-structure checks for pagination architecture. Request construction
 * and response binding are exercised through the real functions in
 * `ref-client-wire.behavior.test.ts`.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REF_CLIENT_FILE = `${HERE}ref-client.ts`;
const SELF = fileURLToPath(import.meta.url);
const CONSOLE_DASHBOARD_DIR = join(HERE, "..");

const TS_FILE_RE = /\.(ts|tsx)$/;
const TEST_FILE_RE = /\.test\.(ts|tsx)$/;
const BARE_UNSCOPED_CALL_RE = /\blistConnectorSummaries\(\s*\)/;
const LIST_ALL_CONNECTOR_SUMMARIES_RE = /\blistAllConnectorSummaries\b/;
const EXHAUSTIVE_FOLD_RE = /\bfoldConnectorSummaryPages\b/;

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // biome-ignore lint/performance/noAwaitInLoops: recursive directory walk, no parallelism benefit for a test-only helper.
      await walk(full, files);
    } else if (TS_FILE_RE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test("source: ref-client.ts has no exhaustive connector-summary fetch primitive", async () => {
  const src = await readFile(REF_CLIENT_FILE, "utf8");
  assert.doesNotMatch(src, LIST_ALL_CONNECTOR_SUMMARIES_RE);
  assert.doesNotMatch(src, EXHAUSTIVE_FOLD_RE);
});

test("source: production console callers never use a bare unscoped summary request", async () => {
  const files = (await walk(CONSOLE_DASHBOARD_DIR)).filter(
    (file) => file !== SELF && file !== REF_CLIENT_FILE && !TEST_FILE_RE.test(file)
  );
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const offenders = files.filter((_file, index) => BARE_UNSCOPED_CALL_RE.test(sources[index] as string));
  assert.deepEqual(
    offenders,
    [],
    `no production console file may call the bare unscoped listConnectorSummaries(). Offenders:\n${offenders.join("\n")}`
  );
});
