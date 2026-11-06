// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  type BindingAuthorityInput,
  type BindingResolution,
  decideBindingAuthority,
} from "../runtime/binding-authority.ts";
import {
  admittedStartBindings,
  assertBindingAdmissionAvailable,
  requiresProtectedBindingAdmission,
} from "../runtime/run-binding-admission.ts";
import { BrowserBindingPlacementRefused } from "../runtime/binding-control.ts";
import { normalizeBindingDeclarations } from "../runtime/binding-declarations.ts";
import type { BindingInstance } from "../runtime/binding-declarations.ts";

function instance(key: string, kind = key, required = true, constraints?: Record<string, unknown>): BindingInstance {
  return { declaration: constraints === undefined ? {} : { constraints }, interface: undefined, key, kind, required };
}

function grant(instanceKey: string, channels: BindingResolution["channels"]): BindingResolution {
  return {
    channels,
    effectiveConstraints: {},
    handleIdentity: `handle:${instanceKey}`,
    instanceKey,
    lifecycle: "granted",
    mechanism: "trusted-adapter",
    mechanismVersion: "1",
    remainingAmbientAccess: ["other ambient access is unknown"],
  };
}

function input(overrides: Partial<BindingAuthorityInput> = {}): BindingAuthorityInput {
  return {
    accessIdentityByInstance: { browser: { identity: "access-1", revision: "r1" } },
    connectionId: "connection-1",
    instances: [instance("browser")],
    now: 100,
    ownerId: "owner-1",
    policyIdentity: "policy-1",
    resolutions: [],
    runId: "run-1",
    weakerCoverageAuthorizations: [],
    ...overrides,
  };
}

const weakBrowserChannels: BindingResolution["channels"] = {
  "browser.connect": { coverage: "not_observable", observedAttempts: [] },
  "browser.navigate": { coverage: "recorded", observedAttempts: ["https://example.test"] },
};

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    accessIdentity: "access-1",
    accessRevision: "r1",
    channel: "browser.navigate",
    connectionId: "connection-1",
    expiresAt: 200,
    instanceKey: "browser",
    ownerId: "owner-1",
    policyIdentity: "policy-1",
    revoked: false,
    ...overrides,
  };
}

test("required instance without a truthful handle is refused; static availability is not a grant", () => {
  const decision = decideBindingAuthority(input());
  assert.equal(decision.placeable, false);
  assert.deepEqual(decision.refusals, [
    { instanceKey: "browser", reason: "required instance lifecycle is unavailable" },
  ]);
  assert.equal(decision.record.instances[0]?.handleIdentity, undefined);
});

test("bare known kind requests full kind reach and weak coverage needs a channel-specific policy fact", () => {
  const decision = decideBindingAuthority(input({ resolutions: [grant("browser", weakBrowserChannels)] }));
  assert.equal(decision.placeable, false);
  assert.equal(decision.record.instances[0]?.requestedReach, "full_kind_reach");
  assert.deepEqual(
    decision.record.instances[0]?.channels.map(({ name, weakerCoverageAuthorized }) => [
      name,
      weakerCoverageAuthorized,
    ]),
    [
      ["browser.navigate", false],
      ["browser.connect", false],
    ]
  );
  assert.ok(decision.refusals[0]?.reason.includes("browser.navigate"));
  assert.ok(decision.refusals[1]?.reason.includes("browser.connect"));
});

test("one matching weaker-coverage authorization permits only its channel and coverage remains recorded", () => {
  const decision = decideBindingAuthority(
    input({
      resolutions: [grant("browser", weakBrowserChannels)],
      weakerCoverageAuthorizations: [authorization()],
    })
  );
  assert.equal(decision.placeable, false);
  assert.deepEqual(
    decision.record.instances[0]?.channels.map(({ name, coverage, weakerCoverageAuthorized }) => [
      name,
      coverage,
      weakerCoverageAuthorized,
    ]),
    [
      ["browser.navigate", "recorded", true],
      ["browser.connect", "not_observable", false],
    ]
  );
  assert.equal(decision.record.instances[0]?.remainingAmbientAccess?.[0], "other ambient access is unknown");
  assert.deepEqual(decision.record.instances[0]?.channels[0]?.observedAttempts, ["https://example.test"]);
});

test("all exact-match weak channel authorizations allow placement without claiming enforcement", () => {
  const decision = decideBindingAuthority(
    input({
      resolutions: [grant("browser", weakBrowserChannels)],
      weakerCoverageAuthorizations: [authorization(), authorization({ channel: "browser.connect" })],
    })
  );
  assert.equal(decision.placeable, true);
  assert.deepEqual(
    decision.record.instances[0]?.channels.map(({ coverage }) => coverage),
    ["recorded", "not_observable"]
  );
});

test("missing per-channel resolution fails closed, even when a handle was resolved", () => {
  const decision = decideBindingAuthority(
    input({
      resolutions: [
        grant("browser", {
          "browser.navigate": { coverage: "enforced", observedAttempts: [] },
        }),
      ],
    })
  );
  assert.equal(decision.placeable, false);
  assert.ok(decision.refusals[0]?.reason.includes("browser.connect"));
  assert.equal(decision.record.instances[0]?.channels[1]?.coverage, "not_observable");
});

test("missing grant identity/mechanism facts cannot become an effective grant", () => {
  const decision = decideBindingAuthority(
    input({ resolutions: [{ channels: weakBrowserChannels, instanceKey: "browser", lifecycle: "granted" }] })
  );
  assert.equal(decision.record.instances[0]?.lifecycle, "unavailable");
  assert.equal(decision.record.instances[0]?.effectiveConstraints, undefined);
  assert.equal(decision.record.instances[0]?.handleIdentity, undefined);
});

test("missing effective reach facts cannot be replaced with the request", () => {
  const decision = decideBindingAuthority(
    input({
      resolutions: [
        {
          channels: weakBrowserChannels,
          handleIdentity: "handle:browser",
          instanceKey: "browser",
          lifecycle: "granted",
          mechanism: "trusted-adapter",
          mechanismVersion: "1",
        },
      ],
    })
  );
  assert.equal(decision.record.instances[0]?.lifecycle, "unavailable");
  assert.equal(decision.record.instances[0]?.handleIdentity, undefined);
  assert.equal(decision.record.instances[0]?.effectiveConstraints, undefined);
  assert.equal(decision.placeable, false);
});

test("optional unsupported instance remains visible and cannot borrow another instance's availability", () => {
  const decision = decideBindingAuthority(
    input({
      instances: [instance("browser", "browser", true), instance("research", "browser", false)],
      resolutions: [
        grant("browser", {
          "browser.connect": { coverage: "enforced", observedAttempts: [] },
          "browser.navigate": { coverage: "enforced", observedAttempts: [] },
        }),
        { channels: {}, instanceKey: "research", lifecycle: "unsupported" },
      ],
    })
  );
  assert.equal(decision.placeable, true);
  assert.equal(decision.record.instances[1]?.lifecycle, "unsupported");
  assert.equal(decision.record.instances[1]?.handleIdentity, undefined);
  assert.equal(decision.record.instances[1]?.channels[0]?.coverage, "not_observable");
});

test("wrong owner, connection, access identity/revision, policy, expiry and revocation do not authorize", () => {
  const bad = [
    authorization({ ownerId: "other" }),
    authorization({ connectionId: "other" }),
    authorization({ accessIdentity: "old" }),
    authorization({ accessRevision: "old" }),
    authorization({ policyIdentity: "other" }),
    authorization({ expiresAt: 100 }),
    authorization({ revoked: true }),
  ];
  for (const item of bad) {
    const decision = decideBindingAuthority(
      input({
        resolutions: [grant("browser", weakBrowserChannels)],
        weakerCoverageAuthorizations: [item, authorization({ channel: "browser.connect" })],
      })
    );
    assert.equal(decision.placeable, false, JSON.stringify(item));
  }
});

test("instance and channel mismatches cannot reuse an exception", () => {
  const wrongInstance = decideBindingAuthority(
    input({
      accessIdentityByInstance: {
        browser: { identity: "access-1", revision: "r1" },
        other: { identity: "access-1", revision: "r1" },
      },
      instances: [instance("browser", "browser"), instance("other", "browser")],
      resolutions: [grant("browser", weakBrowserChannels), grant("other", weakBrowserChannels)],
      weakerCoverageAuthorizations: [authorization()],
    })
  );
  assert.equal(wrongInstance.placeable, false);
  assert.equal(wrongInstance.record.instances[1]?.channels[0]?.weakerCoverageAuthorized, false);
  const wrongChannel = decideBindingAuthority(
    input({
      resolutions: [grant("browser", weakBrowserChannels)],
      weakerCoverageAuthorizations: [authorization({ channel: "network.hosts" })],
    })
  );
  assert.equal(wrongChannel.placeable, false);
});

test("snapshot copies and freezes caller-owned inputs, effective facts, and outputs", () => {
  const attempts = ["attempt"];
  const effective = { hosts: ["api.example.test"] };
  const sourceChannels = {
    "browser.connect": { coverage: "enforced" as const, observedAttempts: [] },
    "browser.navigate": { coverage: "enforced" as const, observedAttempts: attempts },
  };
  const sourceResolution = { ...grant("browser", sourceChannels), effectiveConstraints: effective };
  const decision = decideBindingAuthority(input({ resolutions: [sourceResolution] }));
  attempts.push("later");
  effective.hosts.push("other.example.test");
  assert.deepEqual(decision.record.instances[0]?.channels[0]?.observedAttempts, ["attempt"]);
  assert.deepEqual(decision.record.instances[0]?.effectiveConstraints, { hosts: ["api.example.test"] });
  assert.ok(Object.isFrozen(decision.record));
  assert.ok(Object.isFrozen(decision.record.instances));
  assert.ok(Object.isFrozen(decision.record.instances[0]?.channels));
  assert.ok(Object.isFrozen(decision.record.instances[0]?.channels[0]?.observedAttempts));
});

test("known kinds expose their minimum channels while unsupported kinds stay ungranted", () => {
  const cases = [
    ["network", ["network.hosts"]],
    ["filesystem", ["filesystem.inputs", "filesystem.outputs"]],
    ["desktop_session", []],
  ] as const;
  for (const [kind, expected] of cases) {
    const resolution = kind === "desktop_session" ? grant(kind, {}) : undefined;
    const decision = decideBindingAuthority(
      input({
        instances: [instance(kind, kind, false)],
        resolutions: resolution === undefined ? [] : [resolution],
      })
    );
    assert.equal(
      decision.record.instances[0]?.lifecycle,
      kind === "desktop_session" ? "unsupported" : "optional_not_granted"
    );
    assert.deepEqual(
      decision.record.instances[0]?.channels.map(({ name }) => name),
      expected
    );
    assert.equal(decision.record.instances[0]?.requestedReach, "full_kind_reach");
    if (kind === "desktop_session") {
      assert.equal(decision.record.instances[0]?.handleIdentity, undefined);
    }
  }
  const unsupportedInterface = decideBindingAuthority(
    input({
      instances: [{ ...instance("browser", "browser", false), interface: "browser@2" }],
      resolutions: [grant("browser", weakBrowserChannels)],
    })
  );
  assert.equal(unsupportedInterface.record.instances[0]?.lifecycle, "unsupported");
  assert.equal(unsupportedInterface.record.instances[0]?.handleIdentity, undefined);
});

test("an approval cannot replace a missing channel resolution", () => {
  const decision = decideBindingAuthority(
    input({
      resolutions: [
        grant("browser", {
          "browser.navigate": { coverage: "enforced" },
        }),
      ],
      weakerCoverageAuthorizations: [authorization({ channel: "browser.connect" })],
    })
  );
  assert.equal(decision.placeable, false, "missing actual connect facts must still block placement");
  assert.equal(decision.record.instances[0]?.channels[1]?.weakerCoverageAuthorized, false);
});

test("additional weak channels remain visible and need their own authorization", () => {
  const decision = decideBindingAuthority(
    input({
      resolutions: [
        grant("browser", {
          "browser.connect": { coverage: "enforced" },
          "browser.downloads": { coverage: "recorded", observedAttempts: ["https://example.test/file"] },
          "browser.navigate": { coverage: "enforced" },
        }),
      ],
    })
  );
  assert.equal(decision.placeable, false, "a provider's extra channel must not escape the coverage check");
  assert.deepEqual(
    decision.record.instances[0]?.channels.map(({ name }) => name),
    ["browser.navigate", "browser.connect", "browser.downloads"]
  );
});

test("observations survive a revoked lifecycle independently of placement", () => {
  const decision = decideBindingAuthority(
    input({
      resolutions: [{ ...grant("browser", weakBrowserChannels), lifecycle: "revoked" }],
      weakerCoverageAuthorizations: [authorization(), authorization({ channel: "browser.connect" })],
    })
  );
  assert.equal(decision.placeable, false);
  assert.equal(decision.record.instances[0]?.lifecycle, "revoked");
  assert.deepEqual(decision.record.instances[0]?.channels[0]?.observedAttempts, ["https://example.test"]);
});

test("applied policy facts are immutable and retained for replay", () => {
  const approved = authorization();
  const decision = decideBindingAuthority(
    input({
      resolutions: [grant("browser", weakBrowserChannels)],
      weakerCoverageAuthorizations: [approved, authorization({ channel: "browser.connect" })],
    })
  );
  assert.equal(decision.placeable, true);
  approved.accessRevision = "changed";
  assert.equal(decision.record.instances[0]?.channels[0]?.authorization?.accessRevision, "r1");
  assert.equal(decision.record.instances[0]?.channels[0]?.authorization?.accessIdentity, "access-1");
  assert.ok(Object.isFrozen(decision.record.instances[0]?.channels[0]?.authorization));
});

test("filesystem input slots remain visible without presenting unresolved paths as limited reach", () => {
  const declaredInput = { accepted_extensions: [".json"], access: "read", env_var: "EXPORT_DIR", kind: "dir" };
  const declaration = {
    inputs: [declaredInput],
    required: true,
  };
  const decision = decideBindingAuthority(
    input({
      instances: [{ ...instance("filesystem"), declaration }],
    })
  );
  declaredInput.accepted_extensions.push(".csv");
  assert.equal(decision.record.instances[0]?.requestedReach, "full_kind_reach");
  assert.deepEqual(decision.record.instances[0]?.requestedDeclaration, {
    inputs: [{ accepted_extensions: [".json"], access: "read", env_var: "EXPORT_DIR", kind: "dir" }],
    required: true,
  });
});

test("empty constraints do not turn unbounded requested reach into a limited declaration", () => {
  const decision = decideBindingAuthority(input({ instances: [instance("browser", "browser", true, {})] }));
  assert.equal(decision.record.instances[0]?.requestedReach, "full_kind_reach");
});

test("duplicate or undeclared resolution facts cannot silently replace the recorded authority", () => {
  assert.throws(
    () =>
      decideBindingAuthority(
        input({
          resolutions: [grant("browser", weakBrowserChannels), grant("browser", weakBrowserChannels)],
        })
      ),
    { message: "duplicate binding resolution for browser" }
  );
  assert.throws(
    () =>
      decideBindingAuthority(
        input({
          resolutions: [grant("orphan", weakBrowserChannels)],
        })
      ),
    { message: "binding resolution names undeclared instance orphan" }
  );
  assert.throws(
    () =>
      decideBindingAuthority(
        input({
          instances: [instance("browser"), instance("browser")],
        })
      ),
    { message: "duplicate binding instance" }
  );
});

test("policy exceptions never rescue a required non-granted lifecycle", () => {
  for (const lifecycle of ["unsupported", "denied", "unavailable", "revoked", "optional_not_granted"] as const) {
    const decision = decideBindingAuthority(
      input({
        resolutions: [{ ...grant("browser", weakBrowserChannels), lifecycle }],
        weakerCoverageAuthorizations: [authorization(), authorization({ channel: "browser.connect" })],
      })
    );
    assert.equal(decision.placeable, false, lifecycle);
    assert.equal(decision.record.instances[0]?.channels[0]?.weakerCoverageAuthorized, false, lifecycle);
  }
});

test("an additional channel can be authorized without changing its recorded coverage", () => {
  const decision = decideBindingAuthority(
    input({
      resolutions: [
        grant("browser", {
          "browser.connect": { coverage: "enforced" },
          "browser.downloads": { coverage: "recorded", observedAttempts: ["https://example.test/file"] },
          "browser.navigate": { coverage: "enforced" },
        }),
      ],
      weakerCoverageAuthorizations: [authorization({ channel: "browser.downloads" })],
    })
  );
  assert.equal(decision.placeable, true);
  const download = decision.record.instances[0]?.channels.find(({ name }) => name === "browser.downloads");
  assert.equal(download?.weakerCoverageAuthorized, true);
  assert.equal(download?.coverage, "recorded");
  assert.deepEqual(download?.observedAttempts, ["https://example.test/file"]);
});

// Canonical profile 3.3.9: independently exercise the runtime consumption seam,
// including a stale persisted authorization whose boolean still says granted.
test("run handoff advertises only exact actual grants and rejects stale policy or foreign scope", () => {
  const instances = normalizeBindingDeclarations({ browser: { required: true }, network: { required: false } });
  const facts = input({
    instances,
    resolutions: [
      grant("browser", weakBrowserChannels),
      { instanceKey: "network", lifecycle: "unsupported", channels: {} },
    ],
    weakerCoverageAuthorizations: [authorization(), authorization({ channel: "browser.connect" })],
  });
  const { record } = decideBindingAuthority(facts);
  const scope = { connectionId: facts.connectionId, ownerId: facts.ownerId, runId: facts.runId };
  assert.deepEqual(admittedStartBindings(scope, instances, record, 100), { browser: {} });
  assert.throws(() => admittedStartBindings(scope, instances, record, 200), BrowserBindingPlacementRefused);
  assert.throws(
    () => admittedStartBindings({ ...scope, runId: "other-run" }, instances, record, 100),
    BrowserBindingPlacementRefused
  );
  assert.throws(
    () => admittedStartBindings({ ...scope, ownerId: "other-owner" }, instances, record, 100),
    BrowserBindingPlacementRefused
  );
  assert.throws(
    () => admittedStartBindings({ ...scope, connectionId: "other-connection" }, instances, record, 100),
    BrowserBindingPlacementRefused
  );
  assert.throws(
    () =>
      admittedStartBindings(
        scope,
        normalizeBindingDeclarations({
          browser: { required: true, rationale: "changed" },
          network: { required: false },
        }),
        record,
        100
      ),
    BrowserBindingPlacementRefused
  );
  assert.throws(() => admittedStartBindings(scope, instances, undefined, 100), BrowserBindingPlacementRefused);
  const missingChannel = {
    ...record,
    instances: record.instances.map((item) =>
      item.instanceKey === "browser" ? { ...item, channels: item.channels.slice(0, 1) } : item
    ),
  };
  assert.throws(() => admittedStartBindings(scope, instances, missingChannel, 100), BrowserBindingPlacementRefused);
});

test("common effect gate refuses required unsupported and unconfigured bindings but negotiates optional omissions", () => {
  const required = normalizeBindingDeclarations({ browser: { required: true } });
  assert.throws(
    () => assertBindingAdmissionAvailable(required, false),
    (error) => error instanceof BrowserBindingPlacementRefused && error.failure.code === "binding_unavailable"
  );
  const unsupported = normalizeBindingDeclarations({ network: { required: true } });
  assert.throws(
    () => assertBindingAdmissionAvailable(unsupported, true),
    (error) => error instanceof BrowserBindingPlacementRefused && error.failure.code === "unsupported_binding"
  );
  const optional = normalizeBindingDeclarations({ network: { required: false } });
  assert.doesNotThrow(() => assertBindingAdmissionAvailable(optional, false));
  assert.equal(requiresProtectedBindingAdmission(optional), false);
});
