// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPlacementOrThrow,
  COLLECTOR_RUNTIME_CAPABILITIES,
  type ConnectorPlacementInput,
  diffRequiredBindings,
  diffRequiredProtocolCapabilities,
  evaluatePlacement,
  PROVIDER_RUNTIME_CAPABILITIES,
  RUNTIME_CAPABILITY_MISMATCH_CODE,
  RUNTIME_CAPABILITY_UNDECLARED_CODE,
  RuntimeCapabilityMismatchError,
  RuntimeCapabilityUndeclaredError,
} from "./runtime-capabilities.ts";

// These fixtures exercise binding gating only, not protocol-capability
// declaration, so they declare protocol_capabilities: [] (the ordinary
// declared-empty-capabilities path) to opt out of the separate
// "undeclared_capabilities" gate covered by its own tests below. None of
// these are testing genuine 0.0.1 legacy-omission behavior, so they use the
// declared variant, not the legacy protocol_contract_version escape hatch.
const apiConnector = {
  connector_id: "github",
  protocol_capabilities: [],
  runtime_requirements: { bindings: { network: { required: true } } },
};

const browserConnector = {
  connector_id: "usaa",
  protocol_capabilities: [],
  runtime_requirements: {
    bindings: { browser: { required: true }, network: { required: true } },
  },
};

const codexConnector = {
  connector_id: "codex",
  protocol_capabilities: [],
  runtime_requirements: { bindings: { filesystem: { required: true } } },
};

const localDeviceConnector = {
  connector_id: "imessage",
  protocol_capabilities: [],
  runtime_requirements: {
    bindings: {
      filesystem: { required: true },
      local_device: { required: true },
    },
  },
};

const oldFailClosedRuntime = {
  bindings: COLLECTOR_RUNTIME_CAPABILITIES.bindings,
  id: "collector-v0.0.1",
  protocolCapabilities: new Set<never>(),
  protocolVersion: "0.0.1",
};

const streamEvidenceConnector = {
  connector_id: "stream-evidence-connector",
  protocol_capabilities: ["STREAM_EVIDENCE" as const],
  runtime_requirements: { bindings: {} },
};

test("collector runtime advertises STREAM_EVIDENCE with its unique protocol version", () => {
  assert.equal(COLLECTOR_RUNTIME_CAPABILITIES.protocolVersion, "0.0.2");
  assert.equal(COLLECTOR_RUNTIME_CAPABILITIES.protocolCapabilities.has("STREAM_EVIDENCE"), true);
});

test("directional compatibility: new runtime accepts an old, legacy 0.0.1 connector", () => {
  assert.deepEqual(
    evaluatePlacement(
      { connector_id: "old-connector", protocol_contract_version: "0.0.1" },
      COLLECTOR_RUNTIME_CAPABILITIES
    ),
    {
      kind: "ok",
      satisfied: [],
    }
  );
});

test("directional compatibility: old fail-closed runtime rejects a STREAM_EVIDENCE emitter", () => {
  assert.deepEqual(diffRequiredProtocolCapabilities(streamEvidenceConnector, oldFailClosedRuntime), [
    "STREAM_EVIDENCE",
  ]);
  const decision = evaluatePlacement(streamEvidenceConnector, oldFailClosedRuntime);
  assert.equal(decision.kind, "missing_capability");
  if (decision.kind === "missing_capability") {
    assert.deepEqual(decision.missing, ["STREAM_EVIDENCE"]);
    assert.equal(decision.runtime, "collector-v0.0.1");
  }
  assert.throws(
    () => assertPlacementOrThrow(streamEvidenceConnector, oldFailClosedRuntime),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeCapabilityMismatchError);
      if (error instanceof RuntimeCapabilityMismatchError) {
        assert.deepEqual(error.missing, ["STREAM_EVIDENCE"]);
        assert.match(error.message, /missing capabilities \[STREAM_EVIDENCE\]/);
      }
      return true;
    }
  );
});

test("directional compatibility: new runtime accepts a STREAM_EVIDENCE emitter", () => {
  assert.equal(evaluatePlacement(streamEvidenceConnector, COLLECTOR_RUNTIME_CAPABILITIES).kind, "ok");
});

test("boundary_claim remains optional and does not require a protocol capability", () => {
  const skipResult = {
    boundary_claim: "provider_history_boundary",
    message: "provider boundary",
    reason: "provider_history_boundary",
    stream: "messages",
    type: "SKIP_RESULT",
  } as const;
  assert.equal(skipResult.boundary_claim, "provider_history_boundary");
  // protocol_contract_version: "0.0.1" stands in for a pre-0.0.2 connector
  // that predates protocol_capabilities entirely; boundary_claim itself
  // needs no capability declaration on either side of that line.
  assert.deepEqual(
    evaluatePlacement({ connector_id: "boundary-only", protocol_contract_version: "0.0.1" }, oldFailClosedRuntime),
    {
      kind: "ok",
      satisfied: [],
    }
  );
});

test("provider runtime advertises network and filesystem but not browser or local_device", () => {
  assert.equal(PROVIDER_RUNTIME_CAPABILITIES.bindings.has("network"), true);
  assert.equal(PROVIDER_RUNTIME_CAPABILITIES.bindings.has("filesystem"), true);
  assert.equal(PROVIDER_RUNTIME_CAPABILITIES.bindings.has("browser"), false);
  assert.equal(PROVIDER_RUNTIME_CAPABILITIES.bindings.has("local_device"), false);
});

test("collector runtime advertises every default binding", () => {
  for (const binding of ["network", "browser", "filesystem", "local_device"] as const) {
    assert.equal(COLLECTOR_RUNTIME_CAPABILITIES.bindings.has(binding), true);
  }
});

test("evaluatePlacement: API connector is eligible for the provider runtime", () => {
  assert.deepEqual(evaluatePlacement(apiConnector, PROVIDER_RUNTIME_CAPABILITIES), {
    kind: "ok",
    satisfied: ["network"],
  });
});

test("evaluatePlacement: browser-required connector fails on provider with named missing binding", () => {
  const decision = evaluatePlacement(browserConnector, PROVIDER_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "missing_capability");
  if (decision.kind === "missing_capability") {
    assert.deepEqual(decision.missing, ["browser"]);
    assert.equal(decision.runtime, "provider");
    assert.equal(decision.connectorId, "usaa");
  }
});

test("evaluatePlacement: local-device connector fails on provider, succeeds on collector", () => {
  const onProvider = evaluatePlacement(localDeviceConnector, PROVIDER_RUNTIME_CAPABILITIES);
  assert.equal(onProvider.kind, "missing_capability");
  if (onProvider.kind === "missing_capability") {
    assert.deepEqual(onProvider.missing, ["local_device"]);
  }

  const onCollector = evaluatePlacement(localDeviceConnector, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(onCollector.kind, "ok");
});

test("evaluatePlacement: filesystem-only connector is eligible on both runtimes", () => {
  assert.equal(evaluatePlacement(codexConnector, PROVIDER_RUNTIME_CAPABILITIES).kind, "ok");
  assert.equal(evaluatePlacement(codexConnector, COLLECTOR_RUNTIME_CAPABILITIES).kind, "ok");
});

test("diffRequiredBindings ignores non-required declarations", () => {
  const optional = {
    connector_id: "x",
    protocol_capabilities: [],
    runtime_requirements: { bindings: { browser: { required: false } } },
  };
  assert.deepEqual(diffRequiredBindings(optional, PROVIDER_RUNTIME_CAPABILITIES), []);
});

test("assertPlacementOrThrow returns satisfied bindings on success", () => {
  const satisfied = assertPlacementOrThrow(apiConnector, PROVIDER_RUNTIME_CAPABILITIES);
  assert.deepEqual([...satisfied], ["network"]);
});

test("assertPlacementOrThrow throws RuntimeCapabilityMismatchError with stable code", () => {
  assert.throws(
    () => assertPlacementOrThrow(browserConnector, PROVIDER_RUNTIME_CAPABILITIES),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeCapabilityMismatchError);
      if (err instanceof RuntimeCapabilityMismatchError) {
        assert.equal(err.code, RUNTIME_CAPABILITY_MISMATCH_CODE);
        assert.deepEqual([...err.missing], ["browser"]);
        assert.equal(err.runtime, "provider");
        assert.equal(err.connectorId, "usaa");
        // Diagnostic must not leak credentials or owner data — the
        // message references the binding name and runtime id only.
        assert.match(err.message, /browser/);
        assert.match(err.message, /collector/i);
      }
      return true;
    }
  );
});

test("assertPlacementOrThrow does not name optional bindings as missing", () => {
  // A connector that declares browser as not-required should pass on a
  // runtime that lacks browser.
  const optional = {
    connector_id: "soft-browser",
    protocol_capabilities: [],
    runtime_requirements: {
      bindings: { browser: { required: false }, network: { required: true } },
    },
  };
  const satisfied = assertPlacementOrThrow(optional, PROVIDER_RUNTIME_CAPABILITIES);
  assert.deepEqual([...satisfied], ["network"]);
});

// TypeScript's discriminated union makes an object matching NEITHER branch
// (no `protocol_capabilities`, no `protocol_contract_version: "0.0.1"`)
// unconstructable for well-typed callers. These fixtures cast past the type
// checker: they deliberately test the runtime guard against a malformed
// value a plain-JS caller could still produce.
test("evaluatePlacement: a connector matching neither union branch is undeclared, not ok", () => {
  const undeclared = { connector_id: "forgot-to-declare" } as unknown as ConnectorPlacementInput;
  const decision = evaluatePlacement(undeclared, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "undeclared_capabilities");
  if (decision.kind === "undeclared_capabilities") {
    assert.equal(decision.connectorId, "forgot-to-declare");
    assert.equal(decision.runtime, "collector");
  }
});

test("evaluatePlacement: an explicit empty protocol_capabilities array is always allowed, no trust flag needed", () => {
  const explicitlyEmpty = { connector_id: "explicit-empty", protocol_capabilities: [] };
  assert.deepEqual(evaluatePlacement(explicitlyEmpty, COLLECTOR_RUNTIME_CAPABILITIES), {
    kind: "ok",
    satisfied: [],
  });
});

test("evaluatePlacement: protocol_contract_version '0.0.1' treats an omitted declaration as empty", () => {
  const legacyContract = { connector_id: "trusted-legacy", protocol_contract_version: "0.0.1" as const };
  assert.deepEqual(evaluatePlacement(legacyContract, COLLECTOR_RUNTIME_CAPABILITIES), {
    kind: "ok",
    satisfied: [],
  });
});

test("evaluatePlacement: an object matching neither union branch is gated as undeclared", () => {
  const malformed = { connector_id: "explicitly-untrusted" } as unknown as ConnectorPlacementInput;
  assert.equal(evaluatePlacement(malformed, COLLECTOR_RUNTIME_CAPABILITIES).kind, "undeclared_capabilities");
});

test("assertPlacementOrThrow throws RuntimeCapabilityUndeclaredError with stable code for an undeclared connector", () => {
  assert.throws(
    () =>
      assertPlacementOrThrow(
        { connector_id: "forgot-to-declare" } as unknown as ConnectorPlacementInput,
        COLLECTOR_RUNTIME_CAPABILITIES
      ),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeCapabilityUndeclaredError);
      if (err instanceof RuntimeCapabilityUndeclaredError) {
        assert.equal(err.code, RUNTIME_CAPABILITY_UNDECLARED_CODE);
        assert.equal(err.connectorId, "forgot-to-declare");
        assert.equal(err.runtime, "collector");
        assert.match(err.message, /protocol_capabilities/);
        assert.match(err.message, /protocol_contract_version/);
      }
      return true;
    }
  );
});
