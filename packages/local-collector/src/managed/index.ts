// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Obtain connectors through the connector manager.
 *
 * One call, {@link obtainManagedConnectors}, walks a pinned lock to a set of
 * definitions the existing runner seam accepts: resolve a pinned digest,
 * verify its signature against host policy, install to a content-addressed
 * cache, and hand the installed artifact to the runner.
 *
 * **Relationship to `@pdpp/connector-manager`.** That package exists on
 * data-connectors#97 (`packages/connector-installer-core`, published name
 * `@pdpp/connector-manager`) and is where this logic belongs. It does not
 * export it yet: its surface today is the incumbent tarball installer —
 * `loadConnectorIndex`, `generateLock`, `installFromLock`, `verifyInstalled`
 * and friends — and it contains no OCI, ORAS or Cosign code at all. #97's OCI
 * work is publisher-side: `scripts/build-connector-oci-artifact.mjs`,
 * `scripts/verify-connector-oci-artifact.mjs` and the publish workflow. The
 * manager's *grow* half is unwritten.
 *
 * So this module is written against the artifact contract rather than against
 * an API that does not exist, and it is shaped to be deleted: every step is a
 * named export with an injected dependency, so when the manager grows
 * `resolve`/`verify`/`install`, this becomes a thin adapter over those calls
 * and the runner seam does not move again. What must not happen is the runner
 * growing a dependency on a shape only this repo knows — hence
 * {@link ConnectorManager}, which is the interface the manager is expected to
 * satisfy, stated here so the eventual swap is a substitution rather than a
 * rewrite.
 */

import type { ConnectorLock, PinnedConnector } from "./artifact-contract.ts";
import {
  type ArtifactIdentityPolicy,
  type RegistryClient,
  type SignatureVerifier,
  verifyPinnedArtifact,
} from "./registry-client.ts";
import { activateRelease, type InstalledRelease, installVerifiedArtifact } from "./install-store.ts";
import { definitionFromProfile, type ManagedDefinition } from "./managed-definitions.ts";

export {
  assertConnectorKey,
  assertDigest,
  assertLayerCardinality,
  CONNECTOR_ARTIFACT_TYPE,
  CONNECTOR_CONFIG_MEDIA_TYPE,
  type CollectionProfile,
  type ConnectorConfig,
  type ConnectorLock,
  crossCheckConfig,
  LAYER_CARDINALITY,
  LAYER_MEDIA_TYPES,
  type PinnedConnector,
  requireLayer,
  selectPlatformManifest,
  UNSUPPORTED_PLATFORM_SELECTION,
} from "./artifact-contract.ts";
export {
  type ArtifactIdentityPolicy,
  defaultArtifactIdentityPolicy,
  PDP_CONNECT_CONNECTOR_IDENTITY,
  type RegistryClient,
  type SignatureVerdict,
  type SignatureVerifier,
  type VerifiedArtifact,
  verifyPinnedArtifact,
} from "./registry-client.ts";
export {
  activateRelease,
  assertRootsDisjoint,
  assertSafeMemberPath,
  digestDirectoryName,
  type InstalledRelease,
  installVerifiedArtifact,
  readTarGz,
  releaseDirectory,
} from "./install-store.ts";
export {
  definitionFromProfile,
  type ManagedDefinition,
  managedConnectorCommand,
  managedDefinitionsFrom,
  managedEntrypointIndex,
} from "./managed-definitions.ts";

/**
 * The surface `@pdpp/connector-manager` is expected to grow.
 *
 * Declared as an interface this repo depends on, and satisfied by
 * {@link obtainManagedConnectors}'s internals today. When the manager ships
 * the real thing, the swap is: import its implementation, delete the local
 * one, keep this type. Writing the expectation down is what makes that a
 * substitution instead of a second rewrite of the consumer.
 */
export interface ConnectorManager {
  /**
   * Verify and install one pinned release, returning where it landed.
   * Installing does not activate.
   */
  install(pinned: PinnedConnector): Promise<InstalledRelease>;
}

/** Everything a host supplies to obtain connectors. */
export interface ObtainManagedConnectorsOptions {
  /** The pinned release set. Digests only; no tag is ever resolved. */
  readonly lock: ConnectorLock;
  /** Where verified releases are installed. Must not contain `durableRoot`. */
  readonly installRoot: string;
  /** Where connectors accumulate collected data. Must not contain `installRoot`. */
  readonly durableRoot: string;
  readonly client: RegistryClient;
  readonly verifier: SignatureVerifier;
  /** Defaults to PDP-Connect's publish workflow identity. */
  readonly identityPolicy?: ArtifactIdentityPolicy;
  /**
   * Whether to point `current` at each installed release.
   *
   * Defaults to `false`, which is the conservative direction and the one the
   * decision's "staged and activated between runs" constraint asks for: a
   * fetch that silently changed what runs would be an update applied
   * mid-collection. A caller that knows no run is in progress opts in.
   */
  readonly activate?: boolean;
}

/**
 * Resolve, verify, install and describe every pinned connector.
 *
 * Failure is per-connector and total: one artifact that fails verification
 * aborts the whole call rather than being skipped. A partial connector set
 * that reports success is worse than an error, because the missing connector
 * looks like a connector the user never configured rather than one whose
 * signature did not check out.
 */
export async function obtainManagedConnectors(
  options: ObtainManagedConnectorsOptions
): Promise<readonly ManagedDefinition[]> {
  const managed: ManagedDefinition[] = [];

  for (const pinned of options.lock.connectors) {
    const artifact = await verifyPinnedArtifact({
      pinned,
      client: options.client,
      verifier: options.verifier,
      ...(options.identityPolicy === undefined ? {} : { identityPolicy: options.identityPolicy }),
    });

    const release = installVerifiedArtifact({
      artifact,
      installRoot: options.installRoot,
      durableRoot: options.durableRoot,
    });

    if (options.activate === true) {
      activateRelease(options.installRoot, release);
    }

    managed.push(definitionFromProfile(artifact.profile, release));
  }

  return Object.freeze(managed);
}
