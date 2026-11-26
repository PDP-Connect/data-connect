// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestingGozar } from "@tnunamak/gozar/testing";
import { bundledRuntimeModules } from "../server/reachability/runtime-modules.ts";
import { projectInventory } from "../server/reachability/projection.ts";
import { untrustedStatePathReason } from "./helpers/trusted-state-path.ts";

test("bundled ngrok resolves the installed package directory; missing ngrok stays host-managed", () => {
  assert.deepEqual(bundledRuntimeModules(() => "/fixture/node_modules/@ngrok/ngrok/package.json"), {
    "@ngrok/ngrok": { kind: "bundled", version: "1.7.0", path: "/fixture/node_modules/@ngrok/ngrok" },
  });
  assert.deepEqual(bundledRuntimeModules(() => { throw new Error("not installed"); }), {
    "@ngrok/ngrok": { kind: "host-managed" },
  });
});

test("an absent ngrok bundle reports a reason and never offers installation", { skip: untrustedStatePathReason(tmpdir()) ?? false }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "reachability-ngrok-"));
  const harness = await createTestingGozar({ effects: [], runtimeModules: bundledRuntimeModules(() => join(home, "absent/package.json")) });
  t.after(async () => { await harness.close(); await rm(home, { recursive: true }); });
  const inventory = projectInventory(await harness.gozar.listProviders({ home, owner: "fixture-owner", refresh: true }));
  const providers = inventory.providers.filter(p => p.providerId.startsWith("ngrok"));
  assert.ok(providers.length > 0);
  for (const provider of providers) {
    assert.ok(Object.values(provider.availability).every(a => a.state !== "available" && a.reason));
    assert.equal(provider.configuration.actions.some(a => a.kind === "install-artifact"), false);
    assert.equal(provider.prerequisites.some(p => p.remedy?.kind === "install-artifact"), false);
  }
});
