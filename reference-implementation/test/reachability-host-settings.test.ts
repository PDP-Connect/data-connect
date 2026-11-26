// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { projectHostSettings, validateHostSettingsInput } from "../server/reachability/host-settings.ts";

test("host-only port policy validates bounds without provider knowledge", () => {
  for (const port of [null, 1, 65_535]) {
    assert.equal(validateHostSettingsInput({ expectedRevision: "revision-one", mode: "off", port }).port, port);
  }
  for (const port of [0, 65_536, 1.5, "3000", undefined]) {
    assert.throws(() => validateHostSettingsInput({ expectedRevision: "revision-one", mode: "off", port }), {
      code: "invalid_input",
    });
  }
});
test("host readiness projection drops private bridge fields", () => {
  const canary = "private-host-canary";
  const projected = projectHostSettings({
    confinement: { known: false, reason: "not-observed" },
    mode: "off",
    password: { known: true, value: false },
    port: { known: true, value: null },
    privateCredential: canary,
    revision: "revision-one",
    target: { known: false, reason: "unavailable" },
  } as unknown as Parameters<typeof projectHostSettings>[0]);
  assert.ok(!JSON.stringify(projected).includes(canary));
});
