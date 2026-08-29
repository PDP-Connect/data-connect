// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { CONNECTOR_PROTOCOL_VERSION } from "@pdpp/connector-protocol";
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

test("collector runtime does not advertise STREAM_EVIDENCE: no local-collector connector emits it and there is no durable delivery path", () => {
  assert.equal(COLLECTOR_RUNTIME_CAPABILITIES.protocolVersion, CONNECTOR_PROTOCOL_VERSION);
  assert.equal(COLLECTOR_RUNTIME_CAPABILITIES.protocolCapabilities.has("STREAM_EVIDENCE"), false);
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

test("directional compatibility: current non-advertised 0.0.2 runtime rejects a new-protocol emitter", () => {
  const decision = evaluatePlacement(streamEvidenceConnector, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "missing_capability");
  if (decision.kind === "missing_capability") {
    assert.deepEqual(decision.missing, ["STREAM_EVIDENCE"]);
  }
});

test("future-only semantic runtime fixture accepts a new-protocol emitter", () => {
  const futureSemanticRuntime = {
    ...COLLECTOR_RUNTIME_CAPABILITIES,
    id: "collector-future-stream-evidence",
    protocolCapabilities: new Set(["STREAM_EVIDENCE" as const]),
  };

  assert.equal(evaluatePlacement(streamEvidenceConnector, futureSemanticRuntime).kind, "ok");
  assert.equal(COLLECTOR_RUNTIME_CAPABILITIES.protocolCapabilities.has("STREAM_EVIDENCE"), false);
});

test("capability withdrawal is fail-closed for emitters but leaves non-emitters placeable", () => {
  const emitterDecision = evaluatePlacement(streamEvidenceConnector, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(emitterDecision.kind, "missing_capability");
  if (emitterDecision.kind === "missing_capability") {
    assert.deepEqual(emitterDecision.missing, ["STREAM_EVIDENCE"]);
  }
  assert.deepEqual(
    evaluatePlacement({ connector_id: "ordinary-connector", protocol_capabilities: [] }, COLLECTOR_RUNTIME_CAPABILITIES),
    {
      kind: "ok",
      satisfied: [],
    }
  );
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
  // An explicitly declared, empty protocol_capabilities connector needs no
  // capability declaration beyond that to use boundary_claim.
  assert.deepEqual(
    evaluatePlacement({ connector_id: "boundary-only", protocol_capabilities: [] }, oldFailClosedRuntime),
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

// `ConnectorPlacementInput` requires `protocol_capabilities` as an array at
// the type level (there is no more `protocol_contract_version: "0.0.1"`
// legacy escape hatch — that bypass was removed entirely because nothing
// separated a genuine legacy artifact from a caller merely claiming to be
// one). These fixtures cast past the type checker: they deliberately test
// the runtime guard against a malformed value a plain-JS caller (e.g. one
// round-tripped through `JSON.parse`) could still produce.

test("evaluatePlacement: an explicit empty protocol_capabilities array is always allowed, no trust flag needed", () => {
  const explicitlyEmpty = { connector_id: "explicit-empty", protocol_capabilities: [] };
  assert.deepEqual(evaluatePlacement(explicitlyEmpty, COLLECTOR_RUNTIME_CAPABILITIES), {
    kind: "ok",
    satisfied: [],
  });
});

test("evaluatePlacement: protocol_capabilities omitted entirely is rejected as undeclared, not silently []", () => {
  // Proves there is no silent `[]` fallback for a malformed object: an
  // object that OMITS `protocol_capabilities` entirely (the exact shape a
  // forged legacy-bypass caller, or a JSON payload missing the field,
  // would produce) must be gated as `"undeclared_capabilities"`, never
  // treated as an empty declaration.
  const omitted = { connector_id: "forgot-to-declare" } as unknown as ConnectorPlacementInput;
  const decision = evaluatePlacement(omitted, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "undeclared_capabilities");
  if (decision.kind === "undeclared_capabilities") {
    assert.equal(decision.connectorId, "forgot-to-declare");
    assert.equal(decision.runtime, "collector");
  }
});

test("evaluatePlacement: a non-array protocol_capabilities (string) is rejected, not silently accepted", () => {
  // The exploit this round's review found: `{ protocol_contract_version:
  // "forged" }`-shaped objects, or any object where `protocol_capabilities`
  // is present but not actually an array, previously slipped past the
  // `"protocol_capabilities" in connector` key-presence check. A string
  // value (which is iterable/`.filter`-less but not an Array) must be
  // rejected outright rather than crashing with an unrelated TypeError or
  // being silently treated as declared.
  const stringCapabilities = {
    connector_id: "forged-string-capabilities",
    protocol_capabilities: "STREAM_EVIDENCE",
  } as unknown as ConnectorPlacementInput;
  const decision = evaluatePlacement(stringCapabilities, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "undeclared_capabilities");
  if (decision.kind === "undeclared_capabilities") {
    assert.equal(decision.connectorId, "forged-string-capabilities");
  }
});

test("evaluatePlacement: a null protocol_capabilities is rejected, not silently accepted", () => {
  const nullCapabilities = {
    connector_id: "nullish-capabilities",
    protocol_capabilities: null,
  } as unknown as ConnectorPlacementInput;
  const decision = evaluatePlacement(nullCapabilities, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "undeclared_capabilities");
  if (decision.kind === "undeclared_capabilities") {
    assert.equal(decision.connectorId, "nullish-capabilities");
  }
});

// Round 3 review finding: `["FORGED"]`, `[null]`, and `[{}]` are each a
// well-formed ARRAY, so the old `Array.isArray`-only guard let them all
// through to `diffRequiredProtocolCapabilities`, which merely `.filter`s
// against the runtime's advertised set — a forged/garbage element that
// happens not to match anything the runtime advertises is silently treated
// as "the runtime doesn't have this yet" (missing_capability) rather than
// "this declaration itself is malformed" (undeclared_capabilities). Each
// case below is mutant-sensitive to the per-element vocabulary check
// specifically, not just the top-level array-shape check above.

test("evaluatePlacement: an array containing a forged string member is rejected as undeclared", () => {
  const forgedMember = {
    connector_id: "forged-member",
    protocol_capabilities: ["FORGED"],
  } as unknown as ConnectorPlacementInput;
  const decision = evaluatePlacement(forgedMember, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "undeclared_capabilities");
  if (decision.kind === "undeclared_capabilities") {
    assert.equal(decision.connectorId, "forged-member");
  }
});

test("evaluatePlacement: an array containing a null member is rejected as undeclared", () => {
  const nullMember = {
    connector_id: "null-member",
    protocol_capabilities: [null],
  } as unknown as ConnectorPlacementInput;
  const decision = evaluatePlacement(nullMember, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "undeclared_capabilities");
  if (decision.kind === "undeclared_capabilities") {
    assert.equal(decision.connectorId, "null-member");
  }
});

test("evaluatePlacement: an array containing an object member is rejected as undeclared", () => {
  const objectMember = {
    connector_id: "object-member",
    protocol_capabilities: [{}],
  } as unknown as ConnectorPlacementInput;
  const decision = evaluatePlacement(objectMember, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "undeclared_capabilities");
  if (decision.kind === "undeclared_capabilities") {
    assert.equal(decision.connectorId, "object-member");
  }
});

test("evaluatePlacement: a mix of one valid and one invalid member is rejected as undeclared", () => {
  // Would wrongly pass through to missing_capability/ok (and silently drop
  // the forged member) if the element check used `.some` instead of
  // `.every` — a single bad member must invalidate the whole declaration.
  const mixedMembers = {
    connector_id: "mixed-members",
    protocol_capabilities: ["STREAM_EVIDENCE", "FORGED"],
  } as unknown as ConnectorPlacementInput;
  const decision = evaluatePlacement(mixedMembers, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "undeclared_capabilities");
  if (decision.kind === "undeclared_capabilities") {
    assert.equal(decision.connectorId, "mixed-members");
  }
});

// TypeScript itself now refuses `protocol_contract_version` as a field of
// `ConnectorPlacementInput` — there is no branch of the type that accepts
// it, so a caller attempting the old legacy-bypass shape gets a compile
// error, not a runtime decision. (Verified interactively: constructing
// `{ connector_id: "x", protocol_contract_version: "0.0.1" }` as a
// `ConnectorPlacementInput` fails `tsc --noEmit` with "Object literal may
// only specify known properties, and 'protocol_contract_version' does not
// exist in type 'ConnectorPlacementInput'." This file intentionally
// contains no such literal — the type deletion itself is the proof.)

test("assertPlacementOrThrow throws RuntimeCapabilityUndeclaredError with stable code for a malformed connector", () => {
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
        assert.doesNotMatch(err.message, /protocol_contract_version/);
      }
      return true;
    }
  );
});
