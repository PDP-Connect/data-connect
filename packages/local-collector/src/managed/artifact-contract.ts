// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The consumer half of the connector artifact contract.
 *
 * These types describe what a PDPP connector OCI artifact *is*, as the
 * publisher actually emits it — not as a design document describes it. Every
 * shape here was read off `scripts/build-connector-oci-artifact.mjs` and
 * `.github/workflows/publish-polyfill-connectors.yml` on data-connectors#97
 * (branch `chore/publish-polyfill-connectors`, head `4addd36e`), because the
 * publisher is the side that decides the bytes and a consumer written against
 * prose rather than against the emitter is a consumer that compiles and then
 * fails on the first real artifact.
 *
 * Two deliberate departures from OCI-ARTIFACT-DESIGN-0911.md are encoded here
 * rather than smoothed over, because the design and the publisher disagree and
 * the publisher wins on anything already built:
 *
 *  1. **A release is a single image manifest today, not an image index.**
 *     Design §1.1 requires an index *always*, even for one platform. The
 *     publisher pushes one manifest (`oras push` with no index), and its own
 *     report flags this as a known departure "for the manager lane". So
 *     {@link resolveArtifact} accepts both and treats the index as the case
 *     that does not exist yet — see {@link ArtifactMediaType}. When the tool
 *     layer lands and the index becomes real, the index branch is already
 *     here; nothing in the runner seam changes.
 *
 *  2. **`platform` is `{os: "any", architecture: "any"}` on every artifact.**
 *     The publisher hardcodes it, because all 40 publishable connectors are
 *     JS-only. Platform *selection* is therefore not implemented here — an
 *     unimplemented selector that silently picks the only candidate reads as
 *     working code and would be wrong the moment Slack ships four. It is a
 *     named gap ({@link UNSUPPORTED_PLATFORM_SELECTION}), not a stub.
 *
 * Nothing in this module performs I/O. It is the vocabulary the fetch,
 * verification and install steps are written against, so that each of those
 * can be tested against a fixture without a registry.
 */

/** Media type of the artifact envelope a reference resolves to. */
export type ArtifactMediaType =
  | "application/vnd.oci.image.manifest.v1+json"
  | "application/vnd.oci.image.index.v1+json";

/**
 * `artifactType` every PDPP connector manifest carries. The publisher passes
 * this to `oras push --artifact-type`; a manifest without it is not a
 * connector artifact and is refused before any layer is read.
 */
export const CONNECTOR_ARTIFACT_TYPE = "application/vnd.pdpp.connector.v1+json";

/** Media type of the config blob, pushed via `oras push --config`. */
export const CONNECTOR_CONFIG_MEDIA_TYPE = "application/vnd.pdpp.connector.config.v1+json";

/**
 * Every layer media type the publisher emits, and how many of each a valid
 * artifact carries.
 *
 * Cardinality is enforced rather than advisory (design §1.2). The reason is
 * confusion resistance, not tidiness: an artifact carrying two code layers has
 * no single answer to "which code did I install", and a verifier that accepts
 * the first one lets the second travel unexamined under a signature that
 * covers both.
 */
export const LAYER_MEDIA_TYPES = Object.freeze({
  profile: "application/vnd.pdpp.connector.profile.v1+json",
  code: "application/vnd.pdpp.connector.code.v1.tar+gzip",
  assets: "application/vnd.pdpp.connector.assets.v1.tar+gzip",
  licenses: "application/vnd.pdpp.connector.licenses.v1.tar+gzip",
  provenance: "application/vnd.pdpp.connector.provenance.v1+json",
  tool: "application/vnd.pdpp.connector.tool.v1.tar+gzip",
} as const);

/**
 * Required/optional layer counts, keyed by media type.
 *
 * `tool` is absent from this table on purpose: the publisher refuses to build
 * any connector needing one (`assertNoUnbundledNativeDependency`), so a tool
 * layer arriving today means the artifact was built by something other than
 * the reviewed publisher. {@link assertLayerCardinality} treats an unknown
 * `vnd.pdpp.*` media type as a rejection rather than something to ignore, so
 * that case fails loudly instead of installing a binary nobody declared.
 */
export const LAYER_CARDINALITY = Object.freeze({
  [LAYER_MEDIA_TYPES.profile]: { min: 1, max: 1 },
  [LAYER_MEDIA_TYPES.code]: { min: 1, max: 1 },
  [LAYER_MEDIA_TYPES.licenses]: { min: 1, max: 1 },
  [LAYER_MEDIA_TYPES.provenance]: { min: 1, max: 1 },
  [LAYER_MEDIA_TYPES.assets]: { min: 0, max: 1 },
} as const);

/** An OCI descriptor: what a manifest says about one blob. */
export interface Descriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
  readonly annotations?: Readonly<Record<string, string>>;
}

/** An OCI image manifest, narrowed to the fields a connector consumer reads. */
export interface ArtifactManifest {
  readonly schemaVersion: number;
  readonly mediaType: ArtifactMediaType;
  readonly artifactType?: string;
  readonly config: Descriptor;
  readonly layers: readonly Descriptor[];
  readonly annotations?: Readonly<Record<string, string>>;
}

/**
 * The config blob, verbatim as `build-connector-oci-artifact.mjs` emits it.
 *
 * This is a *restatement* of facts that also live in the profile layer, stored
 * separately so that a cheap resolve can read it without pulling a 100KB
 * profile. The restatement is only worth anything because
 * {@link crossCheckConfig} verifies the two agree — a config nobody checks is
 * just a second place for the truth to be wrong.
 */
export interface ConnectorConfig {
  readonly config_version: string;
  readonly connector_key: string;
  readonly connector_id: string;
  readonly version: string;
  readonly protocol_version: string;
  readonly display_name: string;
  readonly tier: string;
  readonly platform: { readonly os: string; readonly architecture: string };
  readonly profile_digest: string;
  readonly entrypoint: string;
  readonly runtime: {
    readonly node?: string;
    readonly bindings: readonly string[];
  };
  readonly bundled_tools: readonly {
    readonly name: string;
    readonly version: string;
    readonly path: string;
    readonly license: string;
    readonly layer_digest: string;
  }[];
  readonly licenses: string;
  readonly source: { readonly repository: string; readonly revision: string };
}

/**
 * The Collection Profile manifest, narrowed to what the *runner seam* needs.
 *
 * Deliberately partial. data-connectors has no TypeScript type for this
 * contract at all (OCI-ARTIFACT-DESIGN-0911 §0.3: the sanctioned reader types
 * its payload as `unknown`), so declaring a total type here would be inventing
 * a contract the producing repo has not agreed to. What this consumer needs to
 * build a `LocalCollectorDefinition` is exactly these fields; everything else
 * travels verified but unread.
 */
export interface CollectionProfile {
  readonly protocol_version: string;
  readonly connector_key: string;
  readonly connector_id: string;
  readonly version: string;
  readonly display_name: string;
  readonly runtime_requirements?: {
    readonly bindings?: Readonly<Record<string, { readonly required: boolean }>>;
  };
  readonly streams?: readonly { readonly name?: string; readonly id?: string }[];
}

/**
 * One pinned connector release, as a host records it.
 *
 * `digest` is the whole point: it is what the host resolved, verified and
 * installed, and it is what makes "am I running the release I reviewed" an
 * answerable question. A lock entry carries a `version` too, but only ever as
 * a human-readable label — nothing resolves by it. The decision's constraint
 * is "never by resolving `latest`", and the strongest form of that is for the
 * install path to have no tag-resolution code at all.
 */
export interface PinnedConnector {
  readonly connectorKey: string;
  readonly connectorId: string;
  readonly reference: string;
  readonly version: string;
  readonly digest: string;
}

/** The lock file shape data-connect pins its connector set with. */
export interface ConnectorLock {
  readonly lockVersion: string;
  readonly generatedAt?: string;
  readonly connectors: readonly PinnedConnector[];
}

/**
 * Raised when an artifact declares a platform this host cannot run and no
 * portable variant is offered.
 *
 * Named rather than implemented: see this module's header. Every artifact the
 * publisher builds today is `any/any`, so a selector written now would be
 * untestable against a real artifact and would encode a guess about a shape
 * that does not exist. {@link selectPlatformManifest} throws this instead of
 * guessing.
 */
export const UNSUPPORTED_PLATFORM_SELECTION =
  "platform-specific connector artifacts are not yet published; this host cannot select among them";

/** A digest string, validated. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Reject anything that is not a lowercase-hex sha256 digest.
 *
 * Strictness here is load-bearing rather than defensive. A digest is the only
 * thing standing between this host and arbitrary bytes, and it is concatenated
 * into registry URLs and into filesystem paths. An unvalidated digest string
 * is both a request-forgery primitive and a path-traversal primitive, so it is
 * checked once, at the edge, before it reaches either.
 */
export function assertDigest(value: string, context: string): void {
  if (!DIGEST_PATTERN.test(value)) {
    throw new Error(`${context}: not a sha256 digest: ${JSON.stringify(value)}`);
  }
}

/**
 * A connector key, validated against the same rule the publisher enforces.
 *
 * The publisher refuses to build a connector whose `connector_key` is not a
 * legal OCI repository path component, and the two anomalies it found
 * (`apple_contacts`'s underscore, `google_maps`'s bare-slug `connector_id`)
 * are refused there by name. Applying the identical rule on this side means a
 * key that somehow reached a host is rejected here too, rather than being
 * concatenated into a filesystem path on the strength of the publisher having
 * checked it.
 */
const CONNECTOR_KEY_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function assertConnectorKey(value: string, context: string): void {
  if (!CONNECTOR_KEY_PATTERN.test(value) || value.length > 63) {
    throw new Error(`${context}: not a valid connector key: ${JSON.stringify(value)}`);
  }
}

/**
 * Enforce the layer cardinality table, and reject unknown PDPP layer types.
 *
 * Unknown-means-reject, not unknown-means-ignore. An old host that silently
 * dropped a layer type it did not recognise would install a partial artifact
 * while reporting success — and the layer most likely to be added next is the
 * native-helper binary layer, which is precisely the one that must not be
 * installed by a host too old to know what it is.
 */
export function assertLayerCardinality(layers: readonly Descriptor[]): void {
  const counts = new Map<string, number>();
  for (const layer of layers) {
    counts.set(layer.mediaType, (counts.get(layer.mediaType) ?? 0) + 1);
  }

  for (const [mediaType, count] of counts) {
    if (!(mediaType in LAYER_CARDINALITY)) {
      throw new Error(
        `artifact carries an unrecognized layer media type ${mediaType}; refusing to install a partial artifact`
      );
    }
    const bounds = LAYER_CARDINALITY[mediaType as keyof typeof LAYER_CARDINALITY];
    if (count > bounds.max) {
      throw new Error(`artifact carries ${count} ${mediaType} layers; at most ${bounds.max} is valid`);
    }
  }

  for (const [mediaType, bounds] of Object.entries(LAYER_CARDINALITY)) {
    if (bounds.min > 0 && (counts.get(mediaType) ?? 0) < bounds.min) {
      throw new Error(`artifact is missing its required ${mediaType} layer`);
    }
  }
}

/** Find the single layer of a given media type. Throws when absent. */
export function requireLayer(layers: readonly Descriptor[], mediaType: string): Descriptor {
  const found = layers.filter((layer) => layer.mediaType === mediaType);
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(`expected exactly one ${mediaType} layer, found ${found.length}`);
  }
  return found[0];
}

/**
 * Verify the config's restatement against the artifact it claims to describe.
 *
 * This is the anti-confusion control, and the `connector_key` ↔ repository
 * binding is the part that closes a live gap rather than restating one. The
 * incumbent tarball installer binds `connector_id` to the lock entry for
 * *legacy* artifacts only; Collection Profile artifacts get no identity
 * binding at all, because their `connector_id` is a `registry.pdpp.dev` URI
 * that never matches a registry coordinate. So today nothing structurally
 * prevents the artifact published at one connector's coordinates from
 * containing another connector's code. Binding the key to the last path
 * segment of the reference, and requiring the config and the profile to agree
 * on it, is what makes that substitution detectable.
 */
export function crossCheckConfig(input: {
  readonly config: ConnectorConfig;
  readonly profile: CollectionProfile;
  readonly profileDescriptor: Descriptor;
  readonly reference: string;
  readonly pinned: PinnedConnector;
}): void {
  const { config, profile, profileDescriptor, reference, pinned } = input;

  assertConnectorKey(config.connector_key, "config.connector_key");
  assertDigest(config.profile_digest, "config.profile_digest");

  if (config.profile_digest !== profileDescriptor.digest) {
    throw new Error(
      `config.profile_digest ${config.profile_digest} does not match the profile layer ${profileDescriptor.digest}`
    );
  }

  const repositorySegment = reference.split("/").pop()?.split(":")[0]?.split("@")[0];
  if (config.connector_key !== repositorySegment) {
    throw new Error(
      `config.connector_key ${JSON.stringify(config.connector_key)} does not match the repository path segment ${JSON.stringify(repositorySegment)}`
    );
  }

  if (config.connector_key !== profile.connector_key) {
    throw new Error(
      `config.connector_key ${JSON.stringify(config.connector_key)} disagrees with the profile ${JSON.stringify(profile.connector_key)}`
    );
  }

  if (config.connector_id !== profile.connector_id) {
    throw new Error(
      `config.connector_id ${JSON.stringify(config.connector_id)} disagrees with the profile ${JSON.stringify(profile.connector_id)}`
    );
  }

  if (config.connector_id !== pinned.connectorId) {
    throw new Error(
      `config.connector_id ${JSON.stringify(config.connector_id)} is not the pinned id ${JSON.stringify(pinned.connectorId)}`
    );
  }

  if (config.version !== profile.version) {
    throw new Error(`config.version ${config.version} disagrees with the profile ${profile.version}`);
  }
}

/**
 * Select the manifest for this host from a resolved reference.
 *
 * Today's publisher pushes a single image manifest, so this is a
 * media-type check rather than a selection. The index branch throws a named
 * error rather than picking an entry, for the reason in this module's header:
 * the index does not exist yet, so any selection logic written now is
 * unexercised and its first real input would be Slack's four-platform index —
 * the one case where picking wrong means running a binary built for another
 * architecture.
 */
export function selectPlatformManifest(manifest: ArtifactManifest): ArtifactManifest {
  if (manifest.mediaType === "application/vnd.oci.image.index.v1+json") {
    throw new Error(UNSUPPORTED_PLATFORM_SELECTION);
  }
  if (manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json") {
    throw new Error(`unexpected artifact media type ${manifest.mediaType}`);
  }
  if (manifest.artifactType !== CONNECTOR_ARTIFACT_TYPE) {
    throw new Error(
      `artifactType ${JSON.stringify(manifest.artifactType)} is not ${CONNECTOR_ARTIFACT_TYPE}; refusing to treat this as a connector artifact`
    );
  }
  if (manifest.config.mediaType !== CONNECTOR_CONFIG_MEDIA_TYPE) {
    throw new Error(`config media type ${manifest.config.mediaType} is not ${CONNECTOR_CONFIG_MEDIA_TYPE}`);
  }
  return manifest;
}
