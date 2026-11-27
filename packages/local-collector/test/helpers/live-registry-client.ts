// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The transport and verifier the live-registry tests share.
 *
 * Both tests pull real artifacts from a real registry service, through the
 * consumer's own verification path. They must agree on how bytes are fetched,
 * so the client lives here once rather than in each test.
 */

import type { RegistryClient, SignatureVerifier } from "../../src/managed/index.ts";

/**
 * A real registry client, speaking the OCI distribution API over HTTP.
 *
 * Small enough to live in a test, and deliberately so: a host supplies its own
 * transport, and this one exists to prove the consumer's expectations match a
 * real registry's responses rather than to be the transport anyone ships.
 */
export function httpRegistryClient(baseUrl: string, repositoryPath: string): RegistryClient {
  const manifestAccept = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.oci.image.index.v1+json"].join(
    ", "
  );

  return {
    fetchBlob: async (_reference, requestedDigest) => {
      const response = await fetch(`${baseUrl}/v2/${repositoryPath}/blobs/${requestedDigest}`);
      if (!response.ok) {
        throw new Error(`registry returned ${response.status} for blob ${requestedDigest}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    fetchManifest: async (_reference, requestedDigest) => {
      const response = await fetch(`${baseUrl}/v2/${repositoryPath}/manifests/${requestedDigest}`, {
        headers: { accept: manifestAccept },
      });
      if (!response.ok) {
        throw new Error(`registry returned ${response.status} for manifest ${requestedDigest}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/**
 * Stands in for Cosign, reporting the identity the real publish workflow
 * carries. It cannot prove Sigstore works; it isolates everything else so that
 * the one unproven step is exactly one step.
 */
export const stubVerifier: SignatureVerifier = {
  verify: async () => ({
    certificateIdentity:
      "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main",
    certificateIssuer: "https://token.actions.githubusercontent.com",
  }),
};
