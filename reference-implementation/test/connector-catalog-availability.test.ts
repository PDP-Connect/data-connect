// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The signed connector catalog, not the vendored conformance roster, decides
 * whether a connector can be added. LinkedIn is a KNOWN scaffold in the
 * vendored roster snapshot but is published by the live catalog.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  browserEnrollmentSupport,
  buildConnectionSetupPlan,
  isKnownScaffoldConnector,
} from "../server/connection-setup-plan.ts";
import { mountOwnerConnectorTemplates } from "../server/routes/owner-connector-templates.ts";

const LINKEDIN_MANIFEST = {
  capabilities: { public_listing: { tier: "development" as const } },
  connector_id: "linkedin",
  connector_key: "linkedin",
  display_name: "LinkedIn",
  runtime_requirements: { bindings: { browser: {} } },
  streams: [{ name: "profile" }],
};

// The planner reads only the binding shape.
const PLANNER_MANIFEST = {
  connector_id: "linkedin",
  connector_key: "linkedin",
  runtime_requirements: { bindings: { browser: {} } },
};

async function projectLinkedIn(
  listCatalogPublishedConnectorKeys?: () => Promise<ReadonlySet<string>>
): Promise<Record<string, any>> {
  const captured: { handler?: (req: unknown, res: { json: (body: unknown) => unknown }) => unknown } = {};
  const app = {
    get: (_path: string, ...args: unknown[]) => {
      captured.handler = args.at(-1) as NonNullable<typeof captured.handler>;
      return app;
    },
  };
  mountOwnerConnectorTemplates(app, {
    canonicalConnectorKey: (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
    createRequestConnectorInstanceStore: () => ({ listByOwner: async () => [] }),
    getConnectorManifest: async () => LINKEDIN_MANIFEST,
    getOwnerTokenSubjectId: () => "owner_local",
    handleError: (res: unknown, err: unknown) => {
      (res as { json: (body: unknown) => unknown }).json({ error: String(err) });
    },
    ...(listCatalogPublishedConnectorKeys ? { listCatalogPublishedConnectorKeys } : {}),
    listRegisteredConnectorIds: async () => ["linkedin"],
    projectStorageDisplayName: (displayName) => displayName ?? null,
    requireOwner: (...args: unknown[]) => (args[2] as () => void)(),
    requireToken: (...args: unknown[]) => (args[2] as () => void)(),
    resolveResource: () => "http://localhost",
  });
  const { handler } = captured;
  assert.ok(handler, "route handler must be captured");
  let body: unknown = null;
  await handler(
    { tokenInfo: { subject_id: "owner_local" } },
    {
      json: (value) => {
        body = value;
        return value;
      },
    }
  );
  const [template] = (body as { data: Record<string, any>[] }).data;
  assert.ok(template, "linkedin template must be projected");
  return template;
}

test("vendored roster premise: linkedin is a known scaffold without catalog evidence", () => {
  assert.equal(isKnownScaffoldConnector("linkedin"), true);
  assert.equal(isKnownScaffoldConnector("linkedin", { catalogPublished: false }), true);
});

test("a connector the signed catalog publishes is not a scaffold and can add a browser account", () => {
  assert.equal(isKnownScaffoldConnector("linkedin", { catalogPublished: true }), false);
  assert.equal(browserEnrollmentSupport("linkedin", PLANNER_MANIFEST).canAddAccount, false);
  assert.equal(browserEnrollmentSupport("linkedin", PLANNER_MANIFEST, { catalogPublished: true }).canAddAccount, true);
  const plan = buildConnectionSetupPlan({
    catalogPublished: true,
    connectorKey: "linkedin",
    manifest: PLANNER_MANIFEST,
  });
  assert.equal(plan.catalogDisposition, "browser_collector_manual");
  const unpublished = buildConnectionSetupPlan({ connectorKey: "linkedin", manifest: PLANNER_MANIFEST });
  assert.equal(unpublished.catalogDisposition, "browser_bound_runbook");
});

test("owner connector templates take availability from the signed catalog", async () => {
  const template = await projectLinkedIn(async () => new Set(["linkedin"]));
  assert.equal(template.is_known_scaffold, false);
  assert.equal(template.setup_plan.catalog_disposition, "browser_collector_manual");
});

test("a connector absent from the catalog keeps the roster answer", async () => {
  const template = await projectLinkedIn(async () => new Set(["github"]));
  assert.equal(template.is_known_scaffold, true);
  assert.equal(template.setup_plan.catalog_disposition, "browser_bound_runbook");
});

test("a catalog read failure never makes a roster scaffold available", async () => {
  const failed = await projectLinkedIn(() => Promise.reject(new Error("catalog unreachable")));
  assert.equal(failed.is_known_scaffold, true);
  assert.equal(failed.setup_plan.catalog_disposition, "browser_bound_runbook");
  const unwired = await projectLinkedIn();
  assert.equal(unwired.is_known_scaffold, true);
});
