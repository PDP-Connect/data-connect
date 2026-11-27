// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildOwnerConnectorCatalog, type OwnerConnectorTemplateLike } from "../../lib/connection-catalog.ts";
import { sourceSetupAction } from "../../lib/source-setup-presentation.ts";
import { supportsProviderAuth } from "./[connectorId]/provider-auth-support.ts";

function template(args: {
  connectorKey: string;
  disposition: string;
  modality: string;
  nextStepKind: string;
  setupModality: string;
  tier?: "development" | "preview" | "supported";
}): OwnerConnectorTemplateLike {
  return {
    connector_key: args.connectorKey,
    connector_modality: args.modality,
    display_name: args.connectorKey,
    public_listing: { tier: args.tier ?? "supported" },
    registration_status: "registered",
    setup_plan: {
      catalog_disposition: args.disposition,
      deployment_readiness: { blockers: [], guidance: null, state: "ready" },
      enrollment_key: null,
      next_step_kind: args.nextStepKind,
      owner_actionable: true,
      proof_gate: null,
      runbook_path: null,
      setup_modality: args.setupModality,
      support_state: "supported",
    },
    supported_actions: [
      {
        family: "initiate_connection",
        method: "POST",
        status: "supported",
        url: "https://reference.test/v1/owner/connections/intents",
      },
    ],
    uat_expose_unlisted_connectors: null,
  };
}

const provider = (connectorKey: string, tier?: "development" | "supported") =>
  template({
    connectorKey,
    disposition: "provider_auth_connect",
    modality: "api_network",
    nextStepKind: "open_provider_auth",
    setupModality: "provider_authorization",
    tier,
  });

const catalog = buildOwnerConnectorCatalog(
  [],
  [
    provider("listed-provider"),
    provider("dev-provider", "development"),
    template({
      connectorKey: "blocked-provider",
      disposition: "provider_auth_deployment_blocked",
      modality: "api_network",
      nextStepKind: "needs_deployment_config",
      setupModality: "provider_authorization",
    }),
    template({
      connectorKey: "key-source",
      disposition: "static_secret_connect",
      modality: "api_network",
      nextStepKind: "capture_static_secret",
      setupModality: "static_secret",
    }),
  ]
);

test("every connector the Add page sends to provider authorization passes the support check", () => {
  const linked = catalog
    .map((entry) => sourceSetupAction(entry)?.href ?? "")
    .filter((href) => href.startsWith("/connect/provider-auth/"))
    .map((href) => decodeURIComponent(href.slice("/connect/provider-auth/".length)));
  assert.deepEqual(linked.sort(), ["dev-provider", "listed-provider"]);
  for (const connectorId of linked) {
    assert.equal(supportsProviderAuth(catalog, connectorId), true, connectorId);
  }
});

test("connectors without provider authorization are not found", () => {
  assert.equal(supportsProviderAuth(catalog, "blocked-provider"), false);
  assert.equal(supportsProviderAuth(catalog, "key-source"), false);
  assert.equal(supportsProviderAuth(catalog, "missing"), false);
});
