// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-exposure posture — pure unit coverage (security audit S-1 / S-2, lane A1).
 *
 * The posture module is the single source of truth for "is this deployment
 * internet-facing, and therefore must owner auth be mandatory?" These tests pin
 * the classification matrix and the fail-closed decisions so a regression that
 * re-opens the owner control plane on a hosted deploy is caught here, before any
 * server boots.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  isLoopbackBindHost,
  type OwnerExposureEnv,
  type OwnerExposureInputs,
  resolveOwnerExposurePosture,
} from "../server/owner-exposure-posture.ts";

const TOP_LEVEL_REGEX_1 = /PDPP_OWNER_PASSWORD/;

function posture(overrides: Partial<OwnerExposureInputs & { env: OwnerExposureEnv }> = {}) {
  return resolveOwnerExposurePosture({
    bindHost: "127.0.0.1",
    env: {},
    hasOwnerPassword: false,
    referenceOrigin: null,
    ...overrides,
  });
}

// ── loopback bind-host classification ────────────────────────────────────────
test("isLoopbackBindHost: loopback literals are loopback", () => {
  for (const host of ["127.0.0.1", "127.5.6.7", "localhost", "::1", "[::1]", "LOCALHOST"]) {
    assert.equal(isLoopbackBindHost(host), true, `${host} should be loopback`);
  }
});

test("isLoopbackBindHost: all-interfaces and LAN binds are NOT loopback (exposed)", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "fly-local-6pn"]) {
    assert.equal(isLoopbackBindHost(host), false, `${host} should be exposed, not loopback`);
  }
});

test("isLoopbackBindHost: unset bindHost uses the loopback default", () => {
  assert.equal(isLoopbackBindHost(undefined), true);
  assert.equal(isLoopbackBindHost(null), true);
});

// ── local-dev posture: password optional, open behavior preserved ────────────
test("local-dev (no signals, no password): not hosted, open fall-through, registry unlocked", () => {
  const p = posture();
  assert.equal(p.hosted, false);
  assert.equal(p.refuseBootReason, null, "must not refuse boot in local-dev");
  assert.equal(p.allowUnauthenticatedOwnerWhenDisabled, true, "open fall-through preserved");
  assert.equal(p.lockConnectorRegistry, false, "register route stays open");
});

test("local-dev loopback PDPP_REFERENCE_ORIGIN is NOT a hosted signal", () => {
  const p = posture({ referenceOrigin: "http://localhost:3000" });
  assert.equal(p.hosted, false);
  assert.equal(p.refuseBootReason, null);
});

// ── hosted posture: non-loopback origin → password mandatory ─────────────────
test("hosted via non-loopback PDPP_REFERENCE_ORIGIN + no password → refuse boot", () => {
  const p = posture({ referenceOrigin: "https://app.fly.dev" });
  assert.equal(p.hosted, true);
  assert.ok(p.hostedSignals.includes("PDPP_REFERENCE_ORIGIN=<non-loopback>"));
  assert.ok(p.refuseBootReason, "must refuse boot when hosted without a password");
  assert.match(p.refuseBootReason ?? "", TOP_LEVEL_REGEX_1);
});

test("hosted via explicit non-loopback bindHost + no password → refuse boot", () => {
  const p = posture({ bindHost: "0.0.0.0" });
  assert.equal(p.hosted, true);
  assert.ok(p.hostedSignals.some((s) => s.startsWith("bindHost=")));
  assert.ok(p.refuseBootReason);
});

// ── hosted + password present → boot OK, fail-closed runtime, registry locked ─
test("hosted WITH password: boots, fails closed when disabled (n/a here), locks registry", () => {
  const p = posture({ referenceOrigin: "https://app.fly.dev", hasOwnerPassword: true });
  assert.equal(p.hosted, true);
  assert.equal(p.refuseBootReason, null, "password present → boot allowed");
  assert.equal(p.allowUnauthenticatedOwnerWhenDisabled, false, "hosted fails closed");
  assert.equal(p.lockConnectorRegistry, true, "register route requires owner session");
});

test("PDPP_LOCK_CONNECTOR_REGISTRY=1 locks the registry even in local-dev", () => {
  const p = posture({ env: { PDPP_LOCK_CONNECTOR_REGISTRY: "1" }, hasOwnerPassword: true });
  assert.equal(p.hosted, false, "still local-dev for owner-auth purposes");
  assert.equal(p.lockConnectorRegistry, true, "register route requires owner session");
});

test("a public origin still requires a password on a loopback bind", () => {
  const p = posture({
    bindHost: "127.0.0.1",
    referenceOrigin: "https://app.fly.dev",
    hasOwnerPassword: false,
  });
  assert.equal(p.hosted, true);
  assert.ok(p.refuseBootReason);
});
