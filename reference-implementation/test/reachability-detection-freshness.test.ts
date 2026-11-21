// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestingGozar, type TestingEffect } from "@tnunamak/gozar/testing";
import { projectDraft, projectInventory } from "../server/reachability/projection.ts";
import { ReachabilityService } from "../server/reachability/service.ts";
import { FixtureSecretBackend } from "./fixtures/reachability/secret-backend.ts";
import { untrustedStatePathReason } from "./helpers/trusted-state-path.ts";

const EFFECT_FIXTURES = "../../scripts/reachability/effect-fixtures.ts";
const untrusted = untrustedStatePathReason(tmpdir());
test("polls stay cold or stale; actionable reads refresh once and concurrent reads share detection", {
  skip: untrusted ?? false,
}, async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const home = await mkdtemp(join(tmpdir(), "reachability-detection-"));
  const { createEffectFixtures } = await import(EFFECT_FIXTURES) as {
    createEffectFixtures(): { effects: TestingEffect[]; close(): Promise<void> };
  };
  const fixtures = createEffectFixtures();
  const identity = { bootId: "fixture-boot", instanceId: "fixture-instance" };
  const harness = await createTestingGozar({ effects: fixtures.effects, detectionTtlMs: 1000, identity, secretBackend: new FixtureSecretBackend() });
  t.after(async () => { await harness.close(); await fixtures.close(); await rm(home, { recursive: true }); });
  const service = new ReachabilityService(harness.gozar, {
    identity, hostCapabilities: {}, prepare: async () => {}, acknowledgeDisconnect: async () => {},
    query: { home, owner: "fixture-owner", schemaVersion: 1, target: "127.0.0.1:19876", requirements: {
      reach: "internet", transport: "https", address: "any", payloadAccess: "allow-provider", setup: "allow", protocols: [],
    } },
  });
  const probes = () => harness.events.length;
  const cold = projectInventory(await service.inventory());
  assert.ok(cold.providers.every(p => p.detection?.checkedAt === null && !p.detection.fresh));
  await service.inventory();
  assert.equal(probes(), 0);
  const fresh = projectInventory(await service.inventory(true));
  const firstProbes = probes();
  assert.ok(firstProbes > 0);
  assert.ok(fresh.providers.every(p => p.detection?.checkedAt && p.detection.fresh));
  await service.inventory();
  assert.equal(probes(), firstProbes);
  t.mock.timers.tick(1100);
  const stale = projectInventory(await service.inventory());
  assert.ok(stale.providers.every(p => p.detection?.checkedAt && !p.detection.fresh));
  assert.equal(probes(), firstProbes);
  await Promise.all([service.inventory(true), service.inventory(true)]);
  assert.equal(probes() - firstProbes, firstProbes, "two concurrent refresh reads run one set of provider probes");
  const provider = fresh.providers.find(p => p.providerId === "tailscale-funnel")!;
  const draft = await service.begin(provider.providerId, provider.configuration.revision);
  assert.ok(projectDraft(draft).detection?.checkedAt);
  const beforePolls = probes();
  await service.reload(provider.providerId, draft.draftId);
  await service.reload(provider.providerId, draft.draftId);
  assert.equal(probes(), beforePolls, "draft polls do not probe");
  const refreshed = await service.reload(provider.providerId, draft.draftId, true);
  assert.equal(refreshed.detection?.fresh, true);
  assert.ok(probes() > beforePolls);
});
