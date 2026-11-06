// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startServer } from "../../server/index.ts";
import { CONFORMANCE_ROSTER_LOADED } from "../../server/polyfill-connectors-runtime.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "../fixtures/demo-clients.ts";
import { issueOwnerToken } from "./binding-owner-auth.ts";
import { createBrowserArtifactFixtures } from "./browser-artifact-fixtures.ts";
import { withFixtureSourceDeclaration } from "./fixture-source-declaration.ts";

function profile(key: string): Record<string, unknown> {
  const {
    setup: _setup,
    capabilities: _capabilities,
    ...base
  } = JSON.parse(readFileSync(new URL("../fixtures/collection-profiles/github.json", import.meta.url), "utf8"));
  return withFixtureSourceDeclaration({
    ...base,
    capabilities: { public_listing: { tier: "preview" } },
    connector_id: key,
    connector_key: key,
    manifest_uri: `https://fixtures.pdpp.test/connectors/${key}`,
    runtime_requirements: { bindings: { browser: { required: true } } },
  });
}

/** The actual hosted server, with every optional connector import blocked by its caller. */
export async function runHostedBrowserEnrollmentScenario(): Promise<Record<string, unknown>> {
  assert.equal(CONFORMANCE_ROSTER_LOADED, false);
  const fixtures = createBrowserArtifactFixtures();
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    ownerAuthSubjectId: "owner_local",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
  });
  try {
    const asUrl = `http://127.0.0.1:${server.asPort}`;
    const statuses = await Promise.all(
      ["chatgpt", "whoop", "book-shelf", "anthropic", "bare-browser"].map(async (key) => {
        const unpublished = profile(key);
        if (key === "bare-browser") {
          unpublished.browser_enrollment_artifact = {
            manifest: { ...unpublished },
            status: "verified",
            trust: "developer-local-unsigned",
          };
        }
        const manifest = key === "bare-browser" ? unpublished : await fixtures.publish(unpublished);
        const registered = await fetch(`${asUrl}/connectors`, {
          body: JSON.stringify(manifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(registered.status, 201, await registered.text());
        const enrolled = await fetch(`${asUrl}/_ref/connectors/${key}/browser-enrollment-shell`, { method: "POST" });
        await enrolled.arrayBuffer();
        return [key, enrolled.status] as const;
      })
    );
    const token = await issueOwnerToken(asUrl);
    const response = await fetch(`http://127.0.0.1:${server.rsPort}/v1/owner/connector-templates`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: { connector_key: string; setup_plan: { next_step_kind: string } }[];
    };
    const nextSteps = Object.fromEntries(
      body.data
        .filter((item) => statuses.some(([key]) => key === item.connector_key))
        .map((item) => [item.connector_key, item.setup_plan.next_step_kind])
    );
    return { nextSteps, rosterLoaded: CONFORMANCE_ROSTER_LOADED, statuses: Object.fromEntries(statuses) };
  } finally {
    server.schedulerManager?.stop?.();
    await Promise.allSettled([
      new Promise<void>((resolve) => server.asServer.close(() => resolve())),
      new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
    ]);
    fixtures.close();
  }
}
