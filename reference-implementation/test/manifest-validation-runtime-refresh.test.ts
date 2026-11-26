// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for validateRuntimeRequirements + validateRefreshPolicyCapability
// in server/connector-manifest-validation.ts. Both were unpinned by name.
//
// These validators gate what a connector manifest may declare for its runtime
// bindings + external tools and its refresh policy; a loosened check silently
// admits a malformed manifest at registration.
//
// Binding and external-tool declarations are validated independently, including
// external tools in a runtime_requirements object without a bindings member.
//
// Mutation surface:
//   validateRuntimeRequirements -- object-shape guards, RUNTIME_REQUIREMENT_BINDINGS
//     allowlist, `required` boolean, external_tools object/array shape, required
//     name/license/purpose strings, DUPLICATE tool-name rejection, detect.command
//     string, detect.exit_code non-negative integer.
//   validateRefreshPolicyCapability -- REFRESH_POLICY_ALLOWED_KEYS allowlist,
//     recommended_mode enum (automatic|manual|paused), required rationale.

import assert from "node:assert/strict";
import test from "node:test";

import {
  validateRefreshPolicyCapability,
  validateRuntimeRequirements,
} from "../server/connector-manifest-validation.ts";

const CODE = "invalid_request";

function expectReject(fn: () => void, msgIncludes?: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(typeof err === "object" && err !== null);
    const typed = err as { code?: unknown; message?: unknown };
    assert.equal(typed.code, CODE, `expected ${CODE}, got ${String(typed.code)}`);
    if (msgIncludes) {
      assert.ok(
        typeof typed.message === "string" && typed.message.includes(msgIncludes),
        `message "${String(typed.message)}" should include "${msgIncludes}"`
      );
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// validateRuntimeRequirements — bindings
// ---------------------------------------------------------------------------

test("validateRuntimeRequirements: absent runtime_requirements / bindings is a pass", () => {
  assert.doesNotThrow(() => validateRuntimeRequirements({}, CODE));
  assert.doesNotThrow(
    () => validateRuntimeRequirements({ runtime_requirements: {} }, CODE),
    "an absent bindings member does not add a binding requirement"
  );
});

test("validateRuntimeRequirements: a recognized binding with a boolean required passes", () => {
  assert.doesNotThrow(() =>
    validateRuntimeRequirements({ runtime_requirements: { bindings: { browser: { required: true } } } }, CODE)
  );
});

test("validateRuntimeRequirements: an unsupported binding key is rejected", () => {
  expectReject(
    () => validateRuntimeRequirements({ runtime_requirements: { bindings: { teleport: {} } } }, CODE),
    "teleport must have required property 'required'"
  );
});

test("validateRuntimeRequirements: a non-boolean `required` is rejected", () => {
  expectReject(
    () => validateRuntimeRequirements({ runtime_requirements: { bindings: { network: { required: "yes" } } } }, CODE),
    "network.required must be boolean"
  );
});

test("validateRuntimeRequirements: non-object runtime_requirements or bindings is rejected", () => {
  expectReject(() => validateRuntimeRequirements({ runtime_requirements: [] }, CODE), "must be an object");
  expectReject(
    () => validateRuntimeRequirements({ runtime_requirements: { bindings: [] } }, CODE),
    "bindings must be object"
  );
});

// ---------------------------------------------------------------------------
// validateRuntimeRequirements — external_tools (independent of bindings)
// ---------------------------------------------------------------------------

const withBindings = { bindings: { network: { required: true } } };

test("validateRuntimeRequirements: external_tools is validated even when bindings is absent", () => {
  // Formerly an early return skipped external_tools when bindings was absent.
  // The coupling is removed: the invalid entry is rejected either way.
  expectReject(
    () => validateRuntimeRequirements({ runtime_requirements: { external_tools: [{ bogus: 1 }] } }, CODE),
    "has unsupported keys: bogus"
  );
  expectReject(() =>
    validateRuntimeRequirements({ runtime_requirements: { ...withBindings, external_tools: [{ bogus: 1 }] } }, CODE)
  );
  // Control: a valid external_tools entry without bindings still passes.
  assert.doesNotThrow(() =>
    validateRuntimeRequirements(
      {
        runtime_requirements: {
          external_tools: [{ license: "MIT", name: "git", purpose: "vcs" }],
        },
      },
      CODE
    )
  );
});

test("validateRuntimeRequirements: external_tools requires name/license/purpose non-empty strings", () => {
  expectReject(
    () =>
      validateRuntimeRequirements(
        { runtime_requirements: { ...withBindings, external_tools: [{ license: "MIT", purpose: "x" }] } },
        CODE
      ),
    "name must be a non-empty string"
  );
});

test("validateRuntimeRequirements: duplicate external tool names are rejected", () => {
  expectReject(
    () =>
      validateRuntimeRequirements(
        {
          runtime_requirements: {
            ...withBindings,
            external_tools: [
              { license: "MIT", name: "git", purpose: "vcs" },
              { license: "MIT", name: "git", purpose: "vcs again" },
            ],
          },
        },
        CODE
      ),
    "duplicates tool 'git'"
  );
});

test("validateRuntimeRequirements: detect.exit_code must be a non-negative integer", () => {
  expectReject(
    () =>
      validateRuntimeRequirements(
        {
          runtime_requirements: {
            ...withBindings,
            external_tools: [
              { detect: { command: "git --version", exit_code: -1 }, license: "MIT", name: "git", purpose: "vcs" },
            ],
          },
        },
        CODE
      ),
    "exit_code must be a non-negative integer"
  );
  // A valid detect passes.
  assert.doesNotThrow(() =>
    validateRuntimeRequirements(
      {
        runtime_requirements: {
          ...withBindings,
          external_tools: [
            { detect: { command: "git --version", exit_code: 0 }, license: "MIT", name: "git", purpose: "vcs" },
          ],
        },
      },
      CODE
    )
  );
});

// ---------------------------------------------------------------------------
// validateRefreshPolicyCapability
// ---------------------------------------------------------------------------

test("validateRefreshPolicyCapability: absent capabilities / refresh_policy is a pass", () => {
  assert.doesNotThrow(() => validateRefreshPolicyCapability({}, CODE));
  assert.doesNotThrow(() => validateRefreshPolicyCapability({ capabilities: {} }, CODE));
});

test("validateRefreshPolicyCapability: a well-formed refresh_policy passes", () => {
  assert.doesNotThrow(() =>
    validateRefreshPolicyCapability(
      { capabilities: { refresh_policy: { rationale: "daily sync", recommended_mode: "automatic" } } },
      CODE
    )
  );
});

test("validateRefreshPolicyCapability: an unsupported policy key is rejected", () => {
  expectReject(
    () =>
      validateRefreshPolicyCapability(
        { capabilities: { refresh_policy: { bogus: 1, rationale: "x", recommended_mode: "manual" } } },
        CODE
      ),
    "unsupported keys: bogus"
  );
});

test("validateRefreshPolicyCapability: recommended_mode must be automatic/manual/paused", () => {
  expectReject(
    () =>
      validateRefreshPolicyCapability(
        { capabilities: { refresh_policy: { rationale: "x", recommended_mode: "turbo" } } },
        CODE
      ),
    "recommended_mode must be one of"
  );
  // each valid mode passes
  for (const mode of ["automatic", "manual", "paused"]) {
    assert.doesNotThrow(
      () =>
        validateRefreshPolicyCapability(
          { capabilities: { refresh_policy: { rationale: "x", recommended_mode: mode } } },
          CODE
        ),
      `${mode} is a valid mode`
    );
  }
});

test("validateRefreshPolicyCapability: rationale is required (non-empty string)", () => {
  expectReject(
    () => validateRefreshPolicyCapability({ capabilities: { refresh_policy: { recommended_mode: "manual" } } }, CODE),
    "rationale must be a non-empty"
  );
});
