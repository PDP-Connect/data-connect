// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner seam: installed OCI artifacts become injectable collector
 * definitions.
 *
 * This is the whole consumer-side story, and it is small on purpose. The
 * runner already takes its connector set by injection —
 * `createBundledConnectorRegistry(definitions)`, whose own docblock says the
 * registry "is empty until a composition root passes definitions in". So
 * obtaining connectors through a manager does not require a new seam, a
 * plugin system, or a change to `runCollectorConnector`. It requires a second
 * producer of the same `LocalCollectorDefinition[]` the composition root
 * already injects.
 *
 * Two things change, and nothing else does:
 *
 *  1. **Where the entrypoint path comes from.** `resolveBundledConnectorEntry`
 *     computes a path relative to the runner's own `dist/` tree, which is what
 *     makes the connectors *vendored* — they have to be compiled into this
 *     package's build to be found. {@link managedDefinitionsFrom} produces
 *     definitions whose entry resolves to an absolute path inside a verified,
 *     digest-pinned install directory instead.
 *  2. **Where the definition list comes from.** Today it is
 *     `src/generated/collector-definitions.generated.ts`, a "frozen snapshot"
 *     whose own header admits it is a "pinned duplicate, no active
 *     cross-repository drift test". Here it is read from the profile layer of
 *     an artifact whose signature this host verified.
 *
 * `BundledConnectorEntry`'s shape is unchanged, `toBundledEntry` is unchanged,
 * and the runner cannot tell the difference — which is the point. A managed
 * connector and a vendored one are the same kind of thing to the code that
 * runs them; they differ only in how their bytes were obtained and what proves
 * those bytes are right.
 */

import { extname } from "node:path";

import type { LocalCollectorDefinition } from "../../../connector-protocol/src/collector-definition.ts";
import type { CollectionProfile } from "./artifact-contract.ts";
import type { InstalledRelease } from "./install-store.ts";

/**
 * A definition plus the absolute entrypoint the manager resolved for it.
 *
 * `LocalCollectorDefinition.entry` is documented as "a bare directory segment,
 * never a path", and that contract is not bent here — bending it would make
 * the vendored and managed paths disagree about what `entry` means, and the
 * runner resolves `entry` by its own recipe. Instead the absolute path travels
 * alongside, and {@link managedConnectorEntry} turns the pair into the
 * `{command, args, …}` shape the registry wants.
 */
export interface ManagedDefinition {
  readonly definition: LocalCollectorDefinition;
  readonly entrypoint: string;
  readonly digest: string;
  readonly version: string;
}

/**
 * Derive the local-collector definition a verified profile declares.
 *
 * The profile is the connector's own statement of what it needs, and it
 * arrived inside a signed artifact, so this is the first time in this
 * codebase that a connector's declared bindings are *attested* rather than
 * transcribed. The snapshot file this replaces is a hand-regenerated copy
 * whose drift test is `test.skip`'d because the source it would compare
 * against "does not exist in this repository".
 *
 * Fields the profile does not carry are left absent rather than defaulted.
 * `exactOptionalPropertyTypes` is on in this package, so an absent optional is
 * genuinely absent — a defaulted `enforces_source_roots: false` would be a
 * claim about connector behaviour that this module is in no position to make.
 */
export function definitionFromProfile(profile: CollectionProfile, release: InstalledRelease): ManagedDefinition {
  const bindings: Record<string, { required: boolean }> = {};
  for (const [name, binding] of Object.entries(profile.runtime_requirements?.bindings ?? {})) {
    bindings[name] = { required: binding.required };
  }

  const streams: string[] = [];
  for (const stream of profile.streams ?? []) {
    const name = stream.name ?? stream.id;
    if (name !== undefined) streams.push(name);
  }

  const definition: LocalCollectorDefinition = {
    connector_id: profile.connector_id,
    // The runner never resolves this for a managed connector — the absolute
    // entrypoint does. It is carried so a managed definition and a vendored
    // one remain comparable, which is what makes the migration checkable.
    entry: profile.connector_key,
    bindings: Object.freeze(bindings),
    protocol_capabilities: Object.freeze([]),
    streams: Object.freeze(streams),
  };

  return Object.freeze({
    definition: Object.freeze(definition),
    entrypoint: release.entrypoint,
    digest: release.digest,
    version: release.version,
  });
}

/**
 * The command a managed connector is spawned with.
 *
 * Always `process.execPath`, never `tsx`. The vendored path falls back to
 * `"tsx"` for `.ts` entrypoints, which resolves through PATH — acceptable for
 * a monorepo dev loop, wrong for a verified artifact: the whole point of
 * installing signed bytes is undone if running them depends on an unverified
 * transpiler found on PATH. An installed artifact's code layer is a bundled
 * `.mjs`, so the `tsx` branch should be unreachable here, and this asserts
 * that rather than silently falling back to it.
 */
export function managedConnectorCommand(entrypoint: string): string {
  if (extname(entrypoint) === ".ts") {
    throw new Error(
      `managed connector entrypoint ${JSON.stringify(entrypoint)} is TypeScript; installed artifacts must ship a bundled .mjs`
    );
  }
  return process.execPath;
}

/**
 * Turn installed releases into definitions the composition root can inject.
 *
 * The return type is exactly what `createBundledConnectorRegistry` takes, so
 * the composition root's change is a swap of producer, not a rewrite:
 *
 * ```ts
 * createBundledConnectorRegistry(LOCAL_COLLECTOR_DEFINITIONS)   // vendored
 * createBundledConnectorRegistry(managedDefinitionsFrom(...))   // managed
 * ```
 *
 * Both paths must coexist until the manager publishes real artifacts and the
 * new path is proven against them, so this does not replace the snapshot —
 * it stands beside it.
 */
export function managedDefinitionsFrom(
  managed: readonly ManagedDefinition[]
): readonly LocalCollectorDefinition[] {
  return Object.freeze(managed.map((entry) => entry.definition));
}

/**
 * The absolute-entrypoint lookup a managed registry resolves `entry` through.
 *
 * Keyed by `connector_id` rather than by `entry`, because `connector_id` is
 * the identity the artifact's config and profile are cross-checked on and the
 * one the lock pins. `entry` is a directory-name convention inherited from the
 * vendored layout and is not attested by anything.
 */
export function managedEntrypointIndex(
  managed: readonly ManagedDefinition[]
): ReadonlyMap<string, string> {
  return new Map(managed.map((entry) => [entry.definition.connector_id, entry.entrypoint]));
}
