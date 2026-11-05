// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One projection, three surfaces. For every state, the owner template list
 * (what the console's picker reads), the readiness endpoint, and the
 * enrollment route (what refuses or creates a shell) must agree: a shell is
 * created exactly when the projection says `connect`, and the template and the
 * endpoint carry the same projection. The signed catalog is stubbed; no
 * network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";

import { createConnectorInstallService } from "../server/connector-install/index.ts";
import { installedConnectorManifestRegistration } from "../server/connector-install/manifest-registration.ts";
import { startServer } from "../server/index.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { createBrowserArtifactFixtures, setBrowserHostCapability } from "./helpers/browser-artifact-fixtures.ts";

const CATALOG_DIGEST = `sha256:${"a".repeat(64)}`;


function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "expected a JSON object");
  return value as Record<string, unknown>;
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ body: unknown; status: number }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { body: text ? JSON.parse(text) : null, status: response.status };
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const form = { "Content-Type": "application/x-www-form-urlencoded" };
  const device = asRecord(
    (
      await fetchJson(`${asUrl}/oauth/device_authorization`, {
        body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
        headers: form,
        method: "POST",
      })
    ).body
  );
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "owner_local", user_code: String(device.user_code) }).toString(),
    headers: form,
    method: "POST",
  });
  const token = asRecord(
    (
      await fetchJson(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: "cli_longview",
          device_code: String(device.device_code),
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        headers: form,
        method: "POST",
      })
    ).body
  );
  return String(token.access_token);
}

// A real browser-bound manifest under a made-up key: nothing about the key matters.
function browserManifest(connectorId: string): Record<string, unknown> {
  const entry = readPolyfillManifests().find((candidate) => candidate.file === "amazon.json");
  assert.ok(entry, "the amazon polyfill manifest is the browser-bound base");
  return {
    ...(entry.manifest as Record<string, unknown>),
    capabilities: { public_listing: { tier: "development" } },
    connector_id: connectorId,
    connector_key: connectorId,
    display_name: connectorId,
    setup: undefined,
  };
}

async function register(asUrl: string, manifest: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 201, await response.text());
}

async function withStates(
  options: { browserHost: boolean },
  run: (ctx: {
    asUrl: string;
    rsUrl: string;
    token: string;
    fixtures: ReturnType<typeof createBrowserArtifactFixtures>;
  }) => Promise<void>
): Promise<void> {
  const fixtures = createBrowserArtifactFixtures();
  const restoreHost = setBrowserHostCapability(options.browserHost);
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    connectorInstallService: createConnectorInstallService({
      ...installedConnectorManifestRegistration,
      // One published connector that is not installed.
      catalogLoader: async () => [
        {
          bindings: { browser: { required: true } },
          config_digest: `sha256:${"c".repeat(64)}`,
          connector_id: "acme-offered",
          connector_key: "acme-offered",
          digest: CATALOG_DIGEST,
          latest: true,
          tier: "development",
          version: "1.0.0",
        },
      ],
    }),
    dbPath: ":memory:",
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await run({ asUrl, fixtures, rsUrl, token: await issueOwnerToken(asUrl) });
  } finally {
    await closeTestServer(server);
    restoreHost();
    fixtures.close();
  }
}

async function readinessEndpoint(rsUrl: string, token: string, key: string): Promise<Record<string, unknown>> {
  const { body, status } = await fetchJson(
    `${rsUrl}/v1/owner/connector-install/readiness?connector_id=${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  assert.equal(status, 200);
  const data = asRecord(body).data;
  assert.ok(Array.isArray(data) && data.length === 1, "one projection per named connector");
  return asRecord(data[0]);
}

async function templateReadiness(rsUrl: string, token: string, key: string): Promise<unknown> {
  const { body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rows = asRecord(body).data;
  assert.ok(Array.isArray(rows));
  const row = rows.map(asRecord).find((candidate) => candidate.connector_key === key);
  assert.ok(row, `${key} must be a registered template`);
  return row.connector_readiness;
}

async function createShell(asUrl: string, key: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { body, status } = await fetchJson(`${asUrl}/_ref/connectors/${key}/browser-enrollment-shell`, {
    method: "POST",
  });
  return { body: asRecord(body), status };
}

test("the template list, the readiness endpoint and the enrollment route agree on every state", async () => {
  await withStates({ browserHost: true }, async ({ asUrl, fixtures, rsUrl, token }) => {
    // connect: a verified developer-local artifact.
    await register(asUrl, (await fixtures.publish(browserManifest("acme-connect"))) as Record<string, unknown>);
    // repair: the same, then changed on disk.
    await register(asUrl, (await fixtures.publish(browserManifest("acme-broken"))) as Record<string, unknown>);
    fixtures.corrupt("acme-broken");
    // unavailable: registered, nothing installed, not published.
    await register(asUrl, browserManifest("acme-registered-only"));

    const expected = {
      "acme-broken": "repair",
      "acme-connect": "connect",
      "acme-registered-only": "unavailable",
    } as const;
    for (const [key, action] of Object.entries(expected)) {
      const fromEndpoint = await readinessEndpoint(rsUrl, token, key);
      assert.equal(fromEndpoint.action, action, key);
      assert.deepEqual(await templateReadiness(rsUrl, token, key), fromEndpoint, `${key}: template equals endpoint`);

      const shell = await createShell(asUrl, key);
      if (action === "connect") {
        assert.equal(shell.status, 201, `${key}: ${JSON.stringify(shell.body)}`);
      } else {
        assert.equal(shell.status, 409, key);
        assert.equal(asRecord(shell.body.error).code, "connector_browser_setup_unavailable", key);
        assert.match(String(asRecord(shell.body.error).message), new RegExp(String(fromEndpoint.reason)), key);
      }
    }
  });
});

test("a published connector that is not installed is offered install and cannot be enrolled", async () => {
  await withStates({ browserHost: true }, async ({ asUrl, rsUrl, token }) => {
    const readiness = await readinessEndpoint(rsUrl, token, "acme-offered");
    assert.equal(readiness.action, "install");
    assert.equal(readiness.reason, "not_installed");
    // Not registered either: nothing for the route to enroll.
    assert.equal((await createShell(asUrl, "acme-offered")).status, 404);
  });
});

test("with no named connector the endpoint lists every published, installed or developer-local one", async () => {
  await withStates({ browserHost: true }, async ({ asUrl, fixtures, rsUrl, token }) => {
    await register(asUrl, (await fixtures.publish(browserManifest("acme-connect"))) as Record<string, unknown>);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/connector-install/readiness`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const keys = (asRecord(body).data as unknown[]).map((row) => asRecord(row).connector_key);
    assert.deepEqual(keys, ["acme-connect", "acme-offered"]);
  });
});

test("a bare host with no browser variables still enrolls: attended setup needs no scheduler browser surface", async () => {
  await withStates({ browserHost: false }, async ({ asUrl, fixtures, rsUrl, token }) => {
    await register(asUrl, (await fixtures.publish(browserManifest("acme-connect"))) as Record<string, unknown>);
    const readiness = await readinessEndpoint(rsUrl, token, "acme-connect");
    assert.equal(readiness.action, "connect");
    assert.equal(readiness.reason, "runnable");
    assert.deepEqual(await templateReadiness(rsUrl, token, "acme-connect"), readiness);
    const shell = await createShell(asUrl, "acme-connect");
    assert.equal(shell.status, 201);
  });
});

test("the wire verdict is the five fields the console reads, and the refusal message never carries the diagnostic detail", async () => {
  await withStates({ browserHost: true }, async ({ asUrl, fixtures, rsUrl, token }) => {
    await register(asUrl, (await fixtures.publish(browserManifest("acme-broken"))) as Record<string, unknown>);
    fixtures.corrupt("acme-broken");
    const verdict = await readinessEndpoint(rsUrl, token, "acme-broken");
    assert.deepEqual(Object.keys(verdict).sort(), ["action", "browser_bound", "connector_key", "detail", "reason"]);
    assert.ok(verdict.detail, "the diagnostic detail is on the verdict");
    const shell = await createShell(asUrl, "acme-broken");
    const message = String(asRecord(shell.body.error).message);
    assert.match(message, /failed verification/);
    assert.ok(!message.includes(String(verdict.detail)), "detail stays a diagnostic");
  });
});

test("one readiness request may name at most 50 connectors", async () => {
  await withStates({ browserHost: true }, async ({ rsUrl, token }) => {
    const ids = Array.from({ length: 51 }, (_, index) => `connector_id=acme-${index}`).join("&");
    const { status } = await fetchJson(`${rsUrl}/v1/owner/connector-install/readiness?${ids}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(status, 400);
  });
});

test("enforcement rechecks at action time: an artifact that breaks after the list was read is refused", async () => {
  await withStates({ browserHost: true }, async ({ asUrl, fixtures, rsUrl, token }) => {
    await register(asUrl, (await fixtures.publish(browserManifest("acme-connect"))) as Record<string, unknown>);
    assert.equal((await readinessEndpoint(rsUrl, token, "acme-connect")).action, "connect");

    fixtures.corrupt("acme-connect");

    const shell = await createShell(asUrl, "acme-connect");
    assert.equal(shell.status, 409);
    assert.match(String(asRecord(shell.body.error).message), /artifact_invalid/);
  });
});
