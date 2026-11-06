// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The bundled claude_code and codex connectors pass their known local stores
 * to `buildLocalSourceInventory`, which throws when a store is not in the
 * shared expected-store set. When the connector content and the shared set are
 * vendored at different revisions, every run of the packaged collector fails
 * before it emits a record. @pdpp/local-collector 2.4.x shipped that state:
 * claude_code declared `stats_cache` but the shared set did not list it.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CLAUDE_CODE_KNOWN_LOCAL_STORES } from "../../polyfill-connectors/connectors/claude_code/index.ts";
import { CODEX_KNOWN_LOCAL_STORES } from "../../polyfill-connectors/connectors/codex/index.ts";
import { buildLocalSourceInventory } from "../../polyfill-connectors/src/local-source-inventory.ts";

const CASES = [
  ["claude_code", CLAUDE_CODE_KNOWN_LOCAL_STORES],
  ["codex", CODEX_KNOWN_LOCAL_STORES],
] as const;

for (const [connector, stores] of CASES) {
  test(`${connector}: every known local store is in the shared expected-store set`, async () => {
    const home = await mkdtemp(path.join(tmpdir(), `pdpp-${connector}-parity-`));
    try {
      const inventory = await buildLocalSourceInventory(connector, home, stores);
      assert.deepEqual(
        inventory.coverage.map((row) => row.store).sort(),
        stores.map((store) => store.store).sort()
      );
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
}
