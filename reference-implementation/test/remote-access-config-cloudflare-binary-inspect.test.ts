// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `inspectCloudflareTunnel`'s `cloudflared_binary_present` field, tested at
 * the function level rather than through the HTTP route
 * (owner-remote-access-route.test.ts covers that layer): this is a pure
 * env-var mapping, and the three-way `"1"` / `"0"` / absent-or-malformed
 * distinction is exactly the kind of boundary a route-level test would
 * obscure behind an HTTP round trip.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { inspectCloudflareTunnel } from "../server/remote-access-config.ts";

const MANAGED_DESKTOP_ENV = { PDPP_MANAGED_DESKTOP_HOST: "1" };

test("cloudflared_binary_present is true when the Tauri supervisor reports the binary is on PATH", () => {
  const inspection = inspectCloudflareTunnel({
    ...MANAGED_DESKTOP_ENV,
    PDPP_CLOUDFLARED_BINARY_PRESENT: "1",
  });
  assert.equal(inspection.cloudflared_binary_present, true);
  assert.equal(inspection.availability, "available");
});

test("cloudflared_binary_present is false when the Tauri supervisor reports the binary is missing", () => {
  const inspection = inspectCloudflareTunnel({
    ...MANAGED_DESKTOP_ENV,
    PDPP_CLOUDFLARED_BINARY_PRESENT: "0",
  });
  assert.equal(inspection.cloudflared_binary_present, false);
});

test("cloudflared_binary_present is null (unknown), never a false claim of 'missing', when the env var is absent", () => {
  // An older desktop build that predates this check, or any deployment
  // where the flag was simply never set -- must never be misread as a real
  // "not installed" answer, which is what defaulting to `false` would do.
  const inspection = inspectCloudflareTunnel({ ...MANAGED_DESKTOP_ENV });
  assert.equal(inspection.cloudflared_binary_present, null);
});

test("cloudflared_binary_present is null for any value other than the exact strings '1' or '0'", () => {
  const inspection = inspectCloudflareTunnel({
    ...MANAGED_DESKTOP_ENV,
    PDPP_CLOUDFLARED_BINARY_PRESENT: "true",
  });
  assert.equal(inspection.cloudflared_binary_present, null);
});

test("cloudflared_binary_present is null when there is no managed desktop host at all", () => {
  // Matches the existing availability=unavailable case: the binary check
  // never ran here either, so "unknown" is the only honest answer.
  const inspection = inspectCloudflareTunnel({});
  assert.equal(inspection.availability, "unavailable");
  assert.equal(inspection.cloudflared_binary_present, null);
});
