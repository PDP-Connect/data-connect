// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { Action as SetupAction } from "@tnunamak/gozar";
import { projectAction, projectCandidate } from "pdpp-reference-implementation/reachability-projection";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fixture from "../../../../../../reference-implementation/test/fixtures/reachability/configuration.json" with {
  type: "json",
};
import { RouteConsentCard, SetupApprovalCard } from "./reachability-consent.tsx";

const base = fixture.configuration.actions[0] as SetupAction;
const { consent: _baseConsent, ...actionDisclosure } = base;
const routeScope = {
  kind: "route" as const,
  registryId: "registry-one",
  scopeId: "scope-one",
  providerId: base.consent!.scope.providerId,
  configurationRevision: "revision-one",
  query: {
    usage: { kind: "attached" as const },
    reach: "this-device" as const,
    transport: "tcp" as const,
    target: "fixture-target",
    expectedOrigin: null,
  },
};

test("setup card renders only the action snapshot and ignores differing inventory facts", () => {
  const fact = {
    id: "new-fact",
    label: "Action-only disclosure",
    group: "new-group",
    known: true as const,
    value: "long value ".repeat(200),
    affectsConsent: true,
    source: "fixture",
    asOf: null,
  };
  const action = projectAction({
    ...base,
    consent: { ...base.consent!, facts: [fact], disclosures: { action: actionDisclosure } },
  });
  const props = { action, onApprove: () => {}, inventoryFacts: [{ ...fact, label: "Inventory-only disclosure" }] };
  const html = renderToStaticMarkup(createElement(SetupApprovalCard, props));
  assert.ok(html.includes(fact.label));
  assert.ok(html.includes(fact.value));
  assert.ok(!html.includes("Inventory-only disclosure"));
});

test("missing action snapshot blocks setup approval even if inventory facts exist", () => {
  const { consent: _consent, ...bare } = base;
  const props = {
    action: projectAction(bare),
    onApprove: () => {},
    inventoryFacts: [{ label: "Unrelated inventory fact" }],
  };
  const html = renderToStaticMarkup(createElement(SetupApprovalCard, props));
  assert.match(html, /Consent details unavailable from provider library/);
  assert.match(html, /disabled=""/);
  assert.ok(!html.includes("Unrelated inventory fact"));
});

test("setup card shows all typed disclosure groups from the action snapshot", () => {
  const disclosures = {
    action: {
      ...actionDisclosure,
      effects: {
        writes: ["fixture storage", "full disclosure ".repeat(200)],
        networkOrigins: [],
        requiresPrivilege: false,
        restartRequired: false,
      },
      artifact: {
        url: "https://fixture.invalid/archive",
        sha256: "a".repeat(64),
        platform: "fixture",
        architecture: "fixture",
      },
    },
  };
  const action = projectAction({ ...base, consent: { ...base.consent!, facts: [], disclosures } });
  const html = renderToStaticMarkup(createElement(SetupApprovalCard, { action, onApprove: () => {} }));
  for (const text of [
    "effects",
    "fixture storage",
    "full disclosure ".repeat(200),
    "artifact",
    "requiresPrivilege",
    "false",
    "sha256",
    "a".repeat(64),
  ]) {
    assert.ok(html.includes(text));
  }
});

test("route card rejects a digest alias mismatch without showing unrelated catalog facts", () => {
  const candidate = {
    providerId: base.consent!.scope.providerId,
    display: { label: "Fixture", description: "", needs: "" },
    eligible: true,
    consentFactsDigest: "alias-one",
    expiresAt: null,
    disclosure: base.disclosure,
    facts: [],
    configuration: fixture.configuration,
    consent: { scope: routeScope, consentFactsDigest: "alias-two", facts: [], disclosures: {} },
  };
  const review = projectCandidate(candidate as unknown as Parameters<typeof projectCandidate>[0]);
  const html = renderToStaticMarkup(createElement(RouteConsentCard, { review, onApprove: () => {} }));
  assert.match(html, /Consent details unavailable from provider library/);
  assert.match(html, /disabled=""/);
});

test("canary private fields are absent from projected setup and route snapshots", () => {
  const canary = "credential-canary-for-projection";
  const action = {
    ...base,
    privateCredential: canary,
    secretHandle: canary,
    consent: { ...base.consent!, facts: [], disclosures: { action: actionDisclosure }, privateCredential: canary },
  };
  const setup = projectAction(action);
  const route = projectCandidate({
    providerId: base.consent!.scope.providerId,
    display: { label: "Fixture", description: "", needs: "" },
    eligible: true,
    consentFactsDigest: "alias-one",
    expiresAt: null,
    disclosure: base.disclosure,
    facts: [],
    configuration: fixture.configuration,
    privateCredential: canary,
    consent: {
      scope: routeScope,
      consentFactsDigest: "alias-one",
      facts: [],
      disclosures: { action: actionDisclosure },
      privateCredential: canary,
    },
  } as unknown as Parameters<typeof projectCandidate>[0]);
  assert.ok(!JSON.stringify({ setup, route }).includes(canary));
});
