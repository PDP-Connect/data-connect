// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end: pull a REAL connector artifact out of a REAL OCI registry
 * through the consumer path, install it, and import the installed entrypoint.
 *
 * The fixture suite (`managed-connectors.test.ts`) proves the verification
 * logic against artifacts this repo constructs. That is the right shape for
 * the adversarial cases, but it shares one weakness with every fixture: the
 * artifact is built by the same understanding that reads it, so a
 * misunderstanding of the real format would be invisible. This test removes
 * that circularity — the artifact is produced by data-connectors' own
 * `scripts/build-connector-oci-artifact.mjs`, pushed with `oras`, and served
 * by a real registry over HTTP.
 *
 * It is skipped unless `PDPP_TEST_OCI_REGISTRY` names a running registry, so
 * CI and ordinary `npm test` runs are unaffected. To run it:
 *
 *   docker run -d --rm -p 5556:5000 registry:2
 *   node scripts/build-connector-oci-artifact.mjs --connector oura --out /tmp/oura   # in data-connectors
 *   oras push --plain-http localhost:5556/pdp-connect/connector/oura:0.1.0 \
 *     --artifact-type application/vnd.pdpp.connector.v1+json \
 *     --config config.json:application/vnd.pdpp.connector.config.v1+json <layers…>
 *   PDPP_TEST_OCI_REGISTRY=localhost:5556 PDPP_TEST_OCI_DIGEST=sha256:… npm test
 *
 * **What this does not prove.** The registry is a local `registry:2`, not
 * `ghcr.io`, and the signature verifier is a stub that reports the identity
 * the real workflow would carry. Sigstore keyless verification against a
 * Fulcio certificate and a Rekor entry is the one step no local setup
 * reproduces, and it stays unproven until #97 publishes. That gap is named in
 * OCI-CONSUMER-0911.md rather than papered over with a passing test.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  obtainManagedConnectors,
  type RegistryClient,
  type SignatureVerifier,
} from "../src/managed/index.ts";

const registry = process.env.PDPP_TEST_OCI_REGISTRY;
const digest = process.env.PDPP_TEST_OCI_DIGEST;
const repository = process.env.PDPP_TEST_OCI_REPOSITORY ?? "pdp-connect/connector/oura";

/**
 * A real registry client, speaking the OCI distribution API over HTTP.
 *
 * Small enough to live in a test, and deliberately so: a host supplies its own
 * transport, and this one exists to prove the consumer's expectations match a
 * real registry's responses rather than to be the transport anyone ships.
 */
function httpRegistryClient(baseUrl: string, repositoryPath: string): RegistryClient {
  const manifestAccept = [
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json",
  ].join(", ");

  return {
    fetchManifest: async (_reference, requestedDigest) => {
      const response = await fetch(`${baseUrl}/v2/${repositoryPath}/manifests/${requestedDigest}`, {
        headers: { accept: manifestAccept },
      });
      if (!response.ok) throw new Error(`registry returned ${response.status} for manifest ${requestedDigest}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    fetchBlob: async (_reference, requestedDigest) => {
      const response = await fetch(`${baseUrl}/v2/${repositoryPath}/blobs/${requestedDigest}`);
      if (!response.ok) throw new Error(`registry returned ${response.status} for blob ${requestedDigest}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/**
 * Stands in for Cosign, reporting the identity the real publish workflow
 * carries. It cannot prove Sigstore works; it isolates everything else so that
 * the one unproven step is exactly one step.
 */
const stubVerifier: SignatureVerifier = {
  verify: async () => ({
    certificateIdentity:
      "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main",
    certificateIssuer: "https://token.actions.githubusercontent.com",
  }),
};

test(
  "a real artifact pulled from a real registry installs and its entrypoint imports",
  { skip: registry === undefined || digest === undefined ? "set PDPP_TEST_OCI_REGISTRY and PDPP_TEST_OCI_DIGEST" : false },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "managed-live-"));
    try {
      const managed = await obtainManagedConnectors({
        lock: {
          lockVersion: "2.0",
          connectors: [
            {
              connectorKey: "oura",
              connectorId: "https://registry.pdpp.dev/connectors/oura",
              reference: `${registry}/${repository}`,
              version: "0.1.0",
              digest: digest as string,
            },
          ],
        },
        installRoot: join(base, "connector-releases"),
        durableRoot: join(base, "connector-artifacts"),
        client: httpRegistryClient(`http://${registry}`, repository),
        verifier: stubVerifier,
      });

      const entry = managed[0];
      assert.ok(entry, "one connector should have been installed");
      assert.equal(entry.definition.connector_id, "https://registry.pdpp.dev/connectors/oura");

      // The claim worth making: the bytes that came out of the registry are
      // not merely well-formed, they load. A signature says where code came
      // from; it says nothing about whether it runs.
      //
      // The bundle is not fully self-contained, and that is by design rather
      // than by accident: the publisher's esbuild step leaves every package in
      // `packages/polyfill-connectors`'s own `dependencies` external, so an
      // installed `oura` still imports `@pdpp/connector-protocol` at load
      // time. A host therefore has to make the connector runtime resolvable
      // from the install root — the publisher's own verifier does this by
      // symlinking the package's `node_modules` beside the bundle. This is a
      // real consumer obligation that neither design document states, and it
      // is recorded in OCI-CONSUMER-0911.md as an open interface question:
      // whether the runtime travels in the artifact, is provided by the host,
      // or is pinned by the lock is not yet decided.
      const runtimeModules = process.env["PDPP_TEST_CONNECTOR_RUNTIME_MODULES"];
      if (runtimeModules !== undefined) {
        symlinkSync(runtimeModules, join(entry.entrypoint, "..", "..", "node_modules"), "dir");
      }

      const module = (await import(pathToFileURL(entry.entrypoint).href)) as Record<string, unknown>;
      assert.equal(
        typeof module["collectOura"],
        "function",
        "the installed bundle should export the connector's entrypoint"
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
);
