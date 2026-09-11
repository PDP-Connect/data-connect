// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry access and signature verification, as injected capabilities.
 *
 * Nothing in this module reaches a network or spawns a process. It defines the
 * two seams a host supplies and the policy the host must not delegate, so that
 * every step downstream — digest verification, config cross-checking, unpack,
 * install — is testable against a fixture with no registry and no `cosign`.
 *
 * **Why these are injected rather than implemented here.** The decision's
 * phrase is "registry-neutral", and the shape neutrality actually takes in
 * this codebase is already established: the incumbent installer takes
 * `artifactCertificateIdentityResolver` as a caller callback rather than
 * hardcoding a signer, and data-connect supplies it from
 * `scripts/resolve-connectors.js`. Signer policy is the consumer's to decide.
 * This module keeps that arrangement and extends it to blob transport, so a
 * different publisher serving a different registry is a different injected
 * client, not a patch to this file.
 *
 * **The one thing a host may not inject is the expectation that verification
 * happened.** {@link verifyPinnedArtifact} takes a verifier and then checks its
 * answer; it does not accept "verified: true" from anything that travelled
 * with the artifact. An artifact that names its own signer is the failure the
 * incumbent test suite already guards against, and the same rule holds here:
 * the expected identity comes from the host's policy, never from the bytes.
 */

import {
  type ArtifactManifest,
  type ConnectorConfig,
  type CollectionProfile,
  type Descriptor,
  type PinnedConnector,
  assertDigest,
  crossCheckConfig,
  LAYER_MEDIA_TYPES,
  assertLayerCardinality,
  requireLayer,
  selectPlatformManifest,
} from "./artifact-contract.ts";

/**
 * Pull-side registry access, by digest only.
 *
 * There is deliberately no `resolveTag` method. The decision forbids resolving
 * `latest`, and a client that *cannot express* tag resolution enforces that
 * more reliably than a client that can and is asked not to. Tags are an input
 * to lock generation, which is a separate, reviewed act; they are never an
 * input to install.
 */
export interface RegistryClient {
  /**
   * Fetch the manifest a digest names. Implementations must return the raw
   * bytes, not a parsed object — the digest is over bytes, and re-serializing
   * a parsed manifest to check it would verify a different string than the one
   * the signature covers.
   */
  fetchManifest(reference: string, digest: string): Promise<Uint8Array>;
  /** Fetch a blob (config or layer) by digest. */
  fetchBlob(reference: string, digest: string): Promise<Uint8Array>;
}

/** The verdict a signature verifier returns. Deliberately not a boolean. */
export interface SignatureVerdict {
  /** The certificate identity that actually signed, as observed. */
  readonly certificateIdentity: string;
  /** The OIDC issuer that actually issued that certificate, as observed. */
  readonly certificateIssuer: string;
}

/**
 * Verify a Cosign signature over an artifact digest.
 *
 * Returns what it observed rather than whether it approved. Approval is
 * {@link verifyPinnedArtifact}'s job, against the host's injected policy —
 * splitting these means a verifier implementation cannot accidentally become
 * the policy, which is the mistake that lets an artifact vouch for itself.
 *
 * Implementations must verify over the **digest**, never a tag. The publisher
 * signs `${repository}@${digest}` for exactly this reason: a signature over a
 * mutable tag keeps verifying after the bytes beneath it change.
 */
export interface SignatureVerifier {
  verify(input: { readonly reference: string; readonly digest: string }): Promise<SignatureVerdict>;
}

/**
 * The host's answer to "who is allowed to have signed this?".
 *
 * Returning `null` means "no identity is acceptable for this artifact", which
 * fails the install closed. That is the same fail-closed contract the
 * incumbent installer's resolver has, and it is why the return type is
 * nullable rather than the function throwing: a host that has no policy for an
 * artifact should not need to invent an exception type to refuse it.
 */
export interface ArtifactIdentityPolicy {
  (input: { readonly reference: string; readonly connectorKey: string }): {
    readonly certificateIdentityPattern: RegExp;
    readonly certificateIssuer: string;
  } | null;
}

/**
 * The identity PDP-Connect's own publish workflow signs with.
 *
 * Read off `.github/workflows/publish-polyfill-connectors.yml` on
 * data-connectors#97, which verifies its own signature immediately after
 * signing with this exact identity regexp and issuer — so this is the pattern
 * a consumer is *told* to expect by the producer, not one inferred.
 *
 * It is a default, not a constant: a host passes its own policy to
 * {@link verifyPinnedArtifact}, and a different publisher is a different
 * policy rather than a patch here.
 */
export const PDP_CONNECT_CONNECTOR_IDENTITY = Object.freeze({
  certificateIdentityPattern:
    /^https:\/\/github\.com\/PDP-Connect\/data-connectors\/\.github\/workflows\/publish-polyfill-connectors\.yml@/,
  certificateIssuer: "https://token.actions.githubusercontent.com",
});

/** Default policy: PDP-Connect's workflow signs PDP-Connect's connectors. */
export const defaultArtifactIdentityPolicy: ArtifactIdentityPolicy = () => PDP_CONNECT_CONNECTOR_IDENTITY;

/** Everything a verified pull produced, ready to be written to disk. */
export interface VerifiedArtifact {
  readonly pinned: PinnedConnector;
  readonly manifest: ArtifactManifest;
  readonly config: ConnectorConfig;
  readonly profile: CollectionProfile;
  /** Layer bytes, keyed by media type. Digest-verified. */
  readonly layers: ReadonlyMap<string, Uint8Array>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Fetch a blob and prove it is the blob that was asked for.
 *
 * Every blob goes through here. The digest check is what makes the single
 * signature over the manifest cover the whole artifact: the manifest lists
 * layer digests, the signature covers the manifest, and each layer is then
 * checked against its listed digest — so tampering with any layer breaks the
 * chain without needing a signature per layer.
 */
async function fetchVerifiedBlob(
  client: RegistryClient,
  reference: string,
  descriptor: Descriptor
): Promise<Uint8Array> {
  assertDigest(descriptor.digest, `layer ${descriptor.mediaType}`);
  const bytes = await client.fetchBlob(reference, descriptor.digest);
  const actual = await sha256Hex(bytes);
  if (actual !== descriptor.digest) {
    throw new Error(
      `blob digest mismatch for ${descriptor.mediaType}: manifest says ${descriptor.digest}, registry served ${actual}`
    );
  }
  if (descriptor.size !== bytes.byteLength) {
    throw new Error(
      `blob size mismatch for ${descriptor.mediaType}: manifest says ${descriptor.size}, registry served ${bytes.byteLength}`
    );
  }
  return bytes;
}

/**
 * Resolve, verify and pull one pinned connector release.
 *
 * The ordering matters and is the ordering the shared verification contract
 * specifies: **signature before content**. Nothing is parsed as a connector
 * artifact until the digest is proven and the signature over that digest has
 * been checked against the host's policy. A verifier that parsed first would
 * be running attacker-controlled JSON through its own parser before
 * establishing that the bytes came from anyone in particular.
 *
 * Steps:
 *  1. digest-verify the manifest bytes against the *pin* (not against a tag)
 *  2. verify the signature over that digest, against injected policy
 *  3. only then: parse, check artifactType/media types/layer cardinality
 *  4. pull config + layers, each digest-verified
 *  5. cross-check the config's restatement against the profile it describes
 */
export async function verifyPinnedArtifact(input: {
  readonly pinned: PinnedConnector;
  readonly client: RegistryClient;
  readonly verifier: SignatureVerifier;
  readonly identityPolicy?: ArtifactIdentityPolicy;
}): Promise<VerifiedArtifact> {
  const { pinned, client, verifier } = input;
  const identityPolicy = input.identityPolicy ?? defaultArtifactIdentityPolicy;

  assertDigest(pinned.digest, `lock entry for ${pinned.connectorKey}`);

  // (1) The manifest is what the pin names, byte for byte.
  const manifestBytes = await client.fetchManifest(pinned.reference, pinned.digest);
  const manifestDigest = await sha256Hex(manifestBytes);
  if (manifestDigest !== pinned.digest) {
    throw new Error(
      `manifest digest mismatch for ${pinned.connectorKey}: lock pins ${pinned.digest}, registry served ${manifestDigest}`
    );
  }

  // (2) Signature over that digest, judged against the host's policy.
  const expected = identityPolicy({ reference: pinned.reference, connectorKey: pinned.connectorKey });
  if (expected === null) {
    throw new Error(
      `no signing identity is accepted for ${pinned.reference}; refusing to install an artifact this host has no policy for`
    );
  }
  const verdict = await verifier.verify({ reference: pinned.reference, digest: pinned.digest });
  if (!expected.certificateIdentityPattern.test(verdict.certificateIdentity)) {
    throw new Error(
      `${pinned.connectorKey} was signed by ${JSON.stringify(verdict.certificateIdentity)}, which this host does not accept`
    );
  }
  if (verdict.certificateIssuer !== expected.certificateIssuer) {
    throw new Error(
      `${pinned.connectorKey} certificate issuer ${JSON.stringify(verdict.certificateIssuer)} is not ${JSON.stringify(expected.certificateIssuer)}`
    );
  }

  // (3) Now, and only now, treat the bytes as a connector artifact.
  const manifest = selectPlatformManifest(JSON.parse(new TextDecoder().decode(manifestBytes)) as ArtifactManifest);
  assertLayerCardinality(manifest.layers);

  // (4) Config and layers, each proven against the signed manifest.
  const configBytes = await fetchVerifiedBlob(client, pinned.reference, manifest.config);
  const config = JSON.parse(new TextDecoder().decode(configBytes)) as ConnectorConfig;

  const layers = new Map<string, Uint8Array>();
  for (const descriptor of manifest.layers) {
    layers.set(descriptor.mediaType, await fetchVerifiedBlob(client, pinned.reference, descriptor));
  }

  const profileDescriptor = requireLayer(manifest.layers, LAYER_MEDIA_TYPES.profile);
  const profileBytes = layers.get(LAYER_MEDIA_TYPES.profile);
  if (profileBytes === undefined) {
    throw new Error("profile layer was not fetched");
  }
  const profile = JSON.parse(new TextDecoder().decode(profileBytes)) as CollectionProfile;

  // (5) The restatement must match the thing it restates.
  crossCheckConfig({ config, profile, profileDescriptor, reference: pinned.reference, pinned });

  return { pinned, manifest, config, profile, layers };
}
