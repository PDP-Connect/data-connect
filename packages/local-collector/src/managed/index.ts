// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Obtain connectors through the connector manager.
 *
 * **Status.** The published collector does not use {@link obtainManagedConnectors}.
 * It installs through `collection-profiles.ts`, which delegates fetch and
 * signature verification to data-connectors' installer core, which has the
 * OCI and Sigstore path. The verifier in this directory is kept, with its
 * tests, until an owner decides whether to remove it.
 *
 * One call, {@link obtainManagedConnectors}, walks a pinned lock to a set of
 * definitions the existing runner seam accepts: resolve a pinned digest,
 * verify its signature against host policy, install to a content-addressed
 * cache, and hand the installed artifact to the runner.
 *
 * **Relationship to `@pdpp/connector-manager`.** That package is
 * data-connectors' `packages/connector-installer-core` (published here as
 * `@opendatalabs/data-connectors-tools/installer-core`) and is where this logic
 * belongs. It no longer has the tarball installer: it is OCI-only, and its
 * `fetchCatalog`, `fetchResolvedArtifact`, `installFromLock` and
 * `verifyInstalled` resolve a pinned digest, verify its Sigstore signature,
 * check every blob and install a signed Collection Profile. It still does not
 * export the {@link ConnectorManager} shape below, so this module stays
 * written against the artifact contract and is shaped to be deleted: every step
 * is a named export with an injected dependency, so a swap to the core is a
 * substitution rather than a rewrite. What must not happen is the runner
 * growing a dependency on a shape only this repo knows — hence
 * {@link ConnectorManager}, the interface the core is expected to satisfy.
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
  assertContainedEntrypoint,
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
