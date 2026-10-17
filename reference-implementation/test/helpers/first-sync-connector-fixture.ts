// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A connector child for tests that need a first sync to start and stay in
 * flight briefly. It emits nothing, then reports DONE after `holdMs`.
 *
 * Route tests that assert on the setup lifecycle around a first sync need a
 * runnable connector, but not a real one: catalog connectors run only from a
 * verified install, and a real connector would reach its provider.
 */
export function createFirstSyncConnectorFixture(holdMs = 2000): {
  readonly cleanup: () => void;
  readonly connectorPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-first-sync-connector-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.once('line', () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    process.exit(0);
  }, ${holdMs});
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}
