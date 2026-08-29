// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerates `src/generated/collector-definitions.generated.ts` from
 * `@pdpp/polyfill-connectors`'s `LOCAL_COLLECTOR_DEFINITIONS`
 * (`packages/polyfill-connectors/src/collector-registry.ts`).
 *
 * Why this exists: `@pdpp/local-collector` is the publishable runner
 * package; it must not carry a source dependency on
 * `@pdpp/polyfill-connectors` (the content package that owns connector
 * definitions), because that would reintroduce the exact coupling the
 * engine split is removing — the runner reaching into content's source tree
 * for anything beyond the authoring contract it already gets from
 * `@pdpp/connector-protocol`. But the runner's CLI composition root
 * (`bin/pdpp-local-collector.ts`) still needs to know which connectors are
 * bundled and how, to build its `BundledConnectorRegistry`.
 *
 * The resolution: a generated, checked-in snapshot. `polyfill-connectors`
 * remains the one place `LOCAL_COLLECTOR_DEFINITIONS` is authored (connector
 * defines its own collector; the runtime discovers definitions — see
 * `collector-registry.ts`'s own module doc). This script reads that
 * authority ONCE, at build/CI time, and bakes the result into a plain data
 * literal this package imports at runtime with zero cross-package source
 * reach.
 *
 * Current state in this repository: pinned duplicate, no active
 * cross-repository drift test. `test/collector-definitions-snapshot-drift.test.ts`
 * is `test.skip`'d here because its generator imports
 * `packages/polyfill-connectors/src/collector-registry.ts`, which is Move A
 * content and does not exist in this repository. Drift between this
 * snapshot and `polyfill-connectors`' authored definitions is bounded ONLY
 * by the pinned commit map (`docs/migration/collector-commit-map.txt`) until
 * the second tranche establishes a required cross-repository check that
 * compares this snapshot against the canonical connector registry.
 *
 * Update path: after changing any connector's `LocalCollectorDefinition` (or
 * adding/removing a bundled connector) in `polyfill-connectors`, regenerate
 * with `node --experimental-strip-types
 * scripts/generate-collector-definitions-snapshot.ts` from
 * `packages/local-collector`, then commit the updated
 * `src/generated/collector-definitions.generated.ts` alongside the source
 * change. Nothing in this repository currently fails CI if that step is
 * skipped — see the current-state note above.
 *
 * Takes one optional CLI arg: an output path to write to instead of the
 * tracked `src/generated/collector-definitions.generated.ts` (used by the
 * skipped drift test's scratch-directory rendering).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CollectorDefinitionSource, definitionLiteral } from "./collector-definitions-literal.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const targetPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(packageDir, "src/generated/collector-definitions.generated.ts");

const { LOCAL_COLLECTOR_DEFINITIONS } = (await import(
  resolve(packageDir, "../polyfill-connectors/src/collector-registry.ts")
)) as {
  LOCAL_COLLECTOR_DEFINITIONS: readonly CollectorDefinitionSource[];
};

// Fail fast, naming the offending connector, rather than letting
// definitionLiteral's own per-definition throw surface without this
// context. protocol_capabilities is required by LocalCollectorDefinition
// (the authoring type this snapshot mirrors); a definition that omits it or
// has it malformed is a source-of-truth defect, not something to paper over
// by silently truncating this generator's output.
for (const definition of LOCAL_COLLECTOR_DEFINITIONS) {
  if (!Array.isArray(definition.protocol_capabilities)) {
    throw new Error(
      `LOCAL_COLLECTOR_DEFINITIONS entry '${definition.connector_id}' has a missing or malformed ` +
        "protocol_capabilities (expected an array, even if empty). Fix the source definition in " +
        "packages/polyfill-connectors/src/collector-registry.ts before regenerating this snapshot."
    );
  }
}

const entriesBody = LOCAL_COLLECTOR_DEFINITIONS.map((definition) => definitionLiteral(definition)).join("\n");

const output = `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-collector-definitions-snapshot.ts from
// @pdpp/polyfill-connectors's LOCAL_COLLECTOR_DEFINITIONS
// (packages/polyfill-connectors/src/collector-registry.ts), the one place a
// connector declares its local-collector participation. Runtime injection
// here stays a frozen snapshot, not a live cross-package source import, so
// @pdpp/local-collector (the publishable runner) never depends on
// @pdpp/polyfill-connectors (the content package) at build or publish time.
// Current state in this repository: pinned duplicate, no active
// cross-repository drift test. test/collector-definitions-snapshot-drift.test.ts
// is test.skip'd here because its generator imports polyfill-connectors'
// source, which does not exist in this repository. Drift is bounded ONLY by
// the pinned commit map (docs/migration/collector-commit-map.txt) until the
// second tranche establishes a required cross-repository check.
//
// Update path: after changing a connector's LocalCollectorDefinition (or
// adding/removing a bundled connector) in polyfill-connectors, regenerate
// with \`node --experimental-strip-types
// scripts/generate-collector-definitions-snapshot.ts\` from
// packages/local-collector, then commit this file alongside that change.

import type { LocalCollectorDefinition } from "@pdpp/connector-protocol/collector-definition";

/**
 * Frozen snapshot of every connector's local-collector participation, in the
 * order polyfill-connectors declares them. See this file's header for the
 * update path.
 */
export const LOCAL_COLLECTOR_DEFINITIONS: readonly LocalCollectorDefinition[] = Object.freeze([
${entriesBody}
]);
`;

const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, output);
console.log(`wrote ${targetPath}`);
