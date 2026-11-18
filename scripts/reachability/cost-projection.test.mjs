// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
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
