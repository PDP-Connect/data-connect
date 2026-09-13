// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards for the derived shared-connector-source set.
 *
 * These replace a hand-maintained list with a computed one. The failure they
 * exist to catch is a bundled connector importing a shared `../../src/*.ts`
 * module that this repository does not carry or does not compile — which is
 * exactly how `claude_code/artifact-capture.ts`'s import of
 * `../../src/artifact-capture-env.ts` broke the collector build after the
 * connector source moved upstream.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  POLYFILL_CONNECTORS_ROOT,
  deriveConnectorSources,
  readTsconfigSrcIncludes,
} from "../scripts/derive-connector-sources.ts";
import { LOCAL_COLLECTOR_DEFINITIONS } from "../src/generated/collector-definitions.generated.ts";

const tsconfigPath = fileURLToPath(new URL("../tsconfig.build.json", import.meta.url));

/**
 * The connector directory names to walk from.
 *
 * Derived from the generated definitions rather than written out here, so a
 * connector added to or removed from the bundle is covered without editing this
 * test. `entry` is the on-disk directory name, which is what the import graph
 * is rooted at — not `connector_id`, which the protocol keeps as a distinct
 * field even though the two coincide for today's bundle.
 */
const entries = LOCAL_COLLECTOR_DEFINITIONS.map((definition) => definition.entry);

test("every relative import from a bundled connector resolves in this checkout", () => {
  const { unresolved } = deriveConnectorSources(entries);
  assert.deepEqual(
    unresolved,
    [],
    `A bundled connector imports a relative path this repository does not have. ` +
      `Vendor the named module from data-connectors at the pinned commit, then re-run ` +
      `\`npm run derive:connector-sources\`. Unresolved: ` +
      unresolved.map((u) => `${u.from} -> ${u.specifier}`).join(", ")
  );
});

test("tsconfig.build.json compiles exactly the shared modules the connectors reach", () => {
  const { tsconfigIncludes } = deriveConnectorSources(entries);
  const declared = readTsconfigSrcIncludes(tsconfigPath);

  const missing = tsconfigIncludes.filter((f) => !declared.includes(f));
  const extra = declared.filter((f) => !tsconfigIncludes.includes(f));

  assert.deepEqual(
    missing,
    [],
    `These shared modules are reached by a bundled connector's imports but are not in ` +
      `tsconfig.build.json's include array, so the packaging manifest understates what the ` +
      `build compiles. Run \`npm run derive:connector-sources\`. Missing: ${missing.join(", ")}`
  );
  assert.deepEqual(
    extra,
    [],
    `These shared modules are compiled into the published artifact but no bundled connector ` +
      `imports them, so the tarball ships dead weight. Run ` +
      `\`npm run derive:connector-sources\`. Extra: ${extra.join(", ")}`
  );
});

test("every derived shared module exists on disk", () => {
  const { files } = deriveConnectorSources(entries);
  const shared = files.filter((f) => f.startsWith("src/"));
  assert.ok(shared.length > 0, "expected the connectors to reach at least one shared module");
  for (const f of shared) {
    assert.ok(existsSync(join(POLYFILL_CONNECTORS_ROOT, f)), `${f} should exist`);
  }
});
