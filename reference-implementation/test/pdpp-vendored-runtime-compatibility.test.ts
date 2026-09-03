// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consumer-contract test for this repo's own workspace packages.
 *
 * `verifyPdppVendoredPackagePins` (the release-boundary half of this file's
 * original scope) asserted an invariant about `PDP-Connect/pdpp`'s own
 * vendored copies of these packages via a relative import
 * (`../../scripts/check-pdpp-vendored-package-pins.ts`) that only resolved
 * when `reference-implementation/` still lived inside pdpp's monorepo. Now
 * that it has moved to this standalone repo (Move B), that path points
 * outside this repo entirely -- the script does not exist here and
 * structurally cannot, since it is checking an invariant about pdpp's side of
 * the repo boundary, not this one. Removed; pdpp's own suite is responsible
 * for that check if pdpp still wants it.
 *
 * The test below is unaffected -- it exercises `@pdpp/collector-runtime` and
 * `@pdpp/connector-protocol`, both native workspace packages in this repo.
 */

import assert from "node:assert/strict";
import test from "node:test";

test("withdrawn device runtime rejects STREAM_EVIDENCE while protocol 0.0.2 still validates it", async () => {
  const runtime = await import("@pdpp/collector-runtime");
  const protocol = await import("@pdpp/connector-protocol");
  const emitter = {
    connector_id: "synthetic-future-stream-evidence",
    protocol_capabilities: [protocol.STREAM_EVIDENCE_CAPABILITY],
  };

  assert.equal(protocol.CONNECTOR_PROTOCOL_VERSION, "0.0.2");
  assert.doesNotThrow(() =>
    protocol.validateStreamEvidenceCounts({
      considered: 4,
      outcomes: { emitted: 1, gapped: 1, unaccounted: 1, unchanged: 1 },
    })
  );
  assert.equal(runtime.COLLECTOR_RUNTIME_CAPABILITIES.protocolVersion, "0.0.2");
  assert.equal(runtime.COLLECTOR_RUNTIME_CAPABILITIES.protocolCapabilities.has("STREAM_EVIDENCE"), false);
  assert.throws(
    () => runtime.assertPlacementOrThrow(emitter, runtime.COLLECTOR_RUNTIME_CAPABILITIES),
    (error: unknown) => {
      assert.equal(error instanceof runtime.RuntimeCapabilityMismatchError, true);
      assert.deepEqual((error as { missing: readonly string[] }).missing, ["STREAM_EVIDENCE"]);
      return true;
    }
  );
  assert.doesNotThrow(() =>
    runtime.assertPlacementOrThrow(
      { connector_id: "ordinary-non-emitter", protocol_capabilities: [] },
      runtime.COLLECTOR_RUNTIME_CAPABILITIES
    )
  );
});
