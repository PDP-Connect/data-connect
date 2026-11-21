// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cost as fixtureCost } from "../../reference-implementation/test/fixtures/reachability/runtime-cost.mjs";
import fixture from "../../reference-implementation/test/fixtures/reachability/configuration.json" with { type: "json" };
import { projectCandidate, projectRuntimeReview } from "../../reference-implementation/server/reachability/projection.ts";

const scope = {
  kind: "route", registryId: "registry", scopeId: "scope", providerId: "unknown",
  configurationRevision: "revision",
  query: { expectedOrigin: null, target: "127.0.0.1:1", reach: "internet", transport: "https", usage: { kind: "attached" } },
};
const disclosure = { revision: "1", text: "Fixture", links: [] };
const fields = {
  ownership: "external-owned",
  traffic: { tlsTermination: "provider", providerCanReadPayload: false, readers: [], metadataVisibleTo: [], evidenceRef: null },
  address: { conditions: [], ports: null, scope: "public", stability: "ephemeral" },
  protocols: { oauthDcr: false, sse: false, streamableHttp: false },
  disclosure, lifetimes: ["attached"], reach: "internet", supervision: "controller", transport: "https",
};
const review = cost => ({
  kind: "route", consentFactsDigest: "digest", disclosures: { ...fields, cost },
  scope, facts: [], expiresAt: null,
});
const candidate = cost => ({
  configuration: fixture.configuration, consent: review(cost), consentFactsDigest: "digest",
  disclosure, display: { label: "Test", description: "", needs: "" }, eligible: true,
  expiresAt: null, facts: [], providerId: "unknown", ownership: "external-owned",
});

test("route approval and runtime review preserve one closed cost disclosure and ownership", () => {
  for (const cost of [
    { kind: "paid", summary: "Measured rate", amount: 0, currency: "USD", period: "month" },
    { kind: "free", summary: "Free tier" },
    { kind: "unknown", summary: "Ask the provider" },
  ]) {
    const guarded = { ...cost, privateCanary: "private-do-not-project" };
    const projected = projectCandidate(candidate(guarded));
    const runtime = projectRuntimeReview(review(guarded));
    assert.equal(projected.ownership, "external-owned");
    assert.equal(projected.consent.disclosures.ownership, "external-owned");
    assert.deepEqual(projected.consent.disclosures.cost, cost);
    assert.deepEqual(runtime.disclosures.cost, cost);
    assert.equal(runtime.disclosures.ownership, "external-owned");
    assert.ok(!JSON.stringify([projected, runtime]).includes("private-do-not-project"));
    assert.ok(!JSON.stringify([projected, runtime]).includes("gozar.route-cost."));
  }
});

test("typed runtime observations preserve the fixture's distinct free and paid amounts", () => {
  const staticCost = fixtureCost("free");
  assert.deepEqual(projectCandidate(candidate(staticCost)).consent.disclosures.cost, staticCost);
  assert.deepEqual(projectRuntimeReview(review(staticCost)).disclosures.cost, staticCost);
  for (const amount of [0, 125]) {
    const paid = fixtureCost("paid", amount);
    assert.equal(paid.kind, "paid");
    assert.equal(paid.amount, amount);
    assert.deepEqual(projectRuntimeReview(review(paid)).disclosures.cost, paid);
    assert.equal(staticCost.kind, "free");
  }
});

test("decorated fixture observes typed cost without changing the base definition", async t => {
  const root = await mkdtemp(join(tmpdir(), "reachability-cost-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providerDir = join(root, "registry", "providers", "unknown");
  await mkdir(providerDir, { recursive: true });
  const fixtureDir = new URL("../../reference-implementation/test/fixtures/reachability/", import.meta.url);
  for (const file of ["runtime-provider.mjs", "runtime-cost.mjs"]) {
    await copyFile(new URL(file, fixtureDir), join(providerDir, file));
  }
  await writeFile(join(providerDir, "index.mjs"), `
    import { cost } from "./runtime-cost.mjs";
    export default {
      definition: { capabilities: { cost: cost("free") } },
      detect: async () => ({ facts: {} }),
      properties: () => ({}),
      runtimeFacts: async () => ({ properties: {} }),
    };
  `);
  const { default: adapter } = await import(pathToFileURL(join(providerDir, "runtime-provider.mjs")).href);
  const observation = join(root, "runtime-observations.json");
  await assert.rejects(adapter.runtimeFacts(), { code: "ENOENT" });
  for (const [costKind, amount] of [["free", undefined], ["paid", 0], ["paid", 125]]) {
    await writeFile(observation, JSON.stringify({ costKind, amount }));
    const expected = fixtureCost(costKind, amount);
    assert.deepEqual(adapter.definition.capabilities.cost, fixtureCost("free"));
    assert.deepEqual(adapter.properties((await adapter.detect()).facts).cost, expected);
    assert.deepEqual((await adapter.runtimeFacts()).properties.cost, expected);
  }
  await writeFile(observation, "{}");
  await assert.rejects(adapter.detect(), /Invalid fixture cost kind/);
  await assert.rejects(adapter.runtimeFacts(), /Invalid fixture cost kind/);
});

test("invalid fixture observations never project as free", () => {
  for (const kind of [undefined, null, {}, "broken"]) {
    assert.throws(() => fixtureCost(kind), /Invalid fixture cost kind/);
  }
  for (const amount of [null, "125", -1, NaN, Infinity]) {
    assert.throws(() => fixtureCost("paid", amount), /Invalid fixture paid amount/);
  }
});
