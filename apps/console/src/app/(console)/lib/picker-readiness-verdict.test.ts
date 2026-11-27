// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The Add Source picker offers a browser Connect action only when the server's
// readiness verdict says `connect`. The server computes that verdict once and
// uses it for the template's setup plan, the owner-mediated action, and the
// enrollment route's refusal, so the picker and the route cannot disagree. The
// console reads the verdict; it never derives it from a key list, a roster, a
// tier or the manifest's bindings.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOwnerConnectorCatalog,
  type CatalogManifestLike,
  type ConnectorCatalogEntry,
  type OwnerConnectorTemplateLike,
} from "./connection-catalog.ts";
import { type ConnectorReadiness, parseConnectorReadiness } from "./connector-readiness-contract.ts";
import { sourceSetupAction, sourceSetupStatus } from "./source-setup-presentation.ts";

type Tier = "supported" | "preview" | "development";

/** The server's wire verdict for a browser-bound connector. */
function verdict(connectorKey: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return { browser_bound: true, connector_key: connectorKey, detail: null, host: "ready", ...overrides };
}

/**
 * A template as the server projects it. When the verdict is `connect` the
 * server grants the manual-enrollment disposition and the owner-mediated
 * action; for any other verdict it grants neither.
 */
function template(connectorKey: string, tier: Tier, readiness: Record<string, unknown>): OwnerConnectorTemplateLike {
  const connect = readiness.action === "connect";
  return {
    connector_modality: "browser_bound",
    connector_readiness: readiness,
    connector_key: connectorKey,
    display_name: connectorKey,
    public_listing: { tier },
    registration_status: "registered",
    setup_plan: {
      catalog_disposition: connect ? "browser_collector_manual" : "browser_bound_runbook",
      deployment_readiness: { blockers: [], guidance: null, state: "ready" },
      enrollment_key: connect ? connectorKey : null,
      next_step_kind: connect ? "enroll_browser_collector" : "manual_runbook",
      owner_actionable: connect,
      proof_gate: null,
      runbook_path: null,
      setup_modality: "browser_bound",
      support_state: "supported",
    },
    supported_actions: connect
      ? [{ family: "initiate_connection", method: null, status: "owner_mediated", url: null }]
      : [],
  };
}

function pickerEntry(item: OwnerConnectorTemplateLike): ConnectorCatalogEntry {
  const entry = buildOwnerConnectorCatalog([], [item]).find((candidate) => candidate.connectorKey === item.connector_key);
  assert.ok(entry, `${item.connector_key} is listed`);
  return entry;
}

test("a connect verdict gives a Connect action at any tier, with the tier badge unchanged", () => {
  for (const [tier, badge] of [
    ["development", "In development"],
    ["preview", "Preview"],
  ] as const) {
    const entry = pickerEntry(template("acme-shop", tier, verdict("acme-shop", { action: "connect", reason: "runnable" })));
    assert.equal(entry.disposition, "browser_collector_manual");
    assert.equal(entry.readiness?.action, "connect");
    assert.ok(sourceSetupAction(entry), `acme-shop (${tier}) has a Connect action`);
    assert.equal(sourceSetupStatus(entry).label, badge);
  }
});

test("an install verdict gives no Connect action and never reads 'Not built yet'", () => {
  // LinkedIn and Goodreads: published and installable, not yet installed.
  for (const connectorKey of ["linkedin", "goodreads"]) {
    const entry = pickerEntry(
      template(connectorKey, "development", verdict(connectorKey, { action: "install", reason: "not_installed" }))
    );
    assert.equal(entry.readiness?.action, "install");
    assert.equal(sourceSetupAction(entry), null, "installing comes first; there is nothing to connect yet");
    assert.equal(sourceSetupStatus(entry).label, "In development");
  }
});

test("every verdict other than connect gives no Connect action, whatever the key or tier", () => {
  const blocked = [
    { action: "configure", reason: "host_requirement_unmet", detail: "No browser surface is configured." },
    { action: "repair", reason: "artifact_invalid", detail: "entrypoint digest mismatch" },
    { action: "retry", reason: "inspection_unavailable", detail: "EACCES" },
    { action: "retry", reason: "catalog_unavailable" },
    { action: "unavailable", reason: "not_published" },
    { action: "unavailable", reason: "not_browser_bound" },
  ];
  for (const key of ["amazon", "anthropic", "acme-shop"]) {
    for (const tier of ["supported", "preview", "development"] as const) {
      for (const state of blocked) {
        const entry = pickerEntry(template(key, tier, verdict(key, state)));
        assert.equal(sourceSetupAction(entry), null, `${key}/${tier}/${state.reason}`);
      }
    }
  }
});

test("the entry carries the server's reason, so the card can explain a block", () => {
  const entry = pickerEntry(
    template("acme-shop", "preview", verdict("acme-shop", { action: "configure", reason: "host_requirement_unmet", detail: "No display." }))
  );
  const expected: ConnectorReadiness | null = parseConnectorReadiness(
    verdict("acme-shop", { action: "configure", reason: "host_requirement_unmet", detail: "No display." })
  );
  assert.deepEqual(entry.readiness, expected);
});

test("without the server's templates a browser connector gets no Connect action", () => {
  // The manifest-only catalog is the fallback when the server's template list
  // cannot be read. It carries no verdict, so it fails closed.
  const manifest: CatalogManifestLike = {
    capabilities: { public_listing: { tier: "preview" } },
    connector_id: "acme-shop",
    display_name: "acme-shop",
    runtime_requirements: { bindings: { browser: { required: true } } },
  };
  const entry = buildOwnerConnectorCatalog([manifest], []).find((candidate) => candidate.connectorKey === "acme-shop");
  assert.ok(entry);
  assert.equal(entry.readiness, null);
  assert.equal(entry.disposition, "browser_bound_runbook");
  assert.equal(sourceSetupAction(entry), null);
});
