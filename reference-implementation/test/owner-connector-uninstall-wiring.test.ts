// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A server started the production way (no injected install service) must
 * build its install service with the uninstall hooks. Without them every
 * uninstall answers "Connector uninstall is unavailable." before it looks at
 * the connector, which is what a standalone server did on every row the
 * Settings page offered Uninstall for.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startServer } from "../server/index.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";

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

test("a server started without an injected install service can reach uninstall", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-uninstall-wiring-"));
  const previous = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
  });
  try {
    const token = await issueOwnerToken(`http://localhost:${server.asPort}`);
    const response = await fetchJson(`http://localhost:${server.rsPort}/v1/owner/connector-install/uninstall`, {
      body: JSON.stringify({ connector_key: "gmail" }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      method: "POST",
    });
    const text = JSON.stringify(response.body);
    assert.doesNotMatch(text, /Connector uninstall is unavailable/, `uninstall never reached the connector: ${text}`);
    // Nothing is installed in this data directory, so the hooked service gets
    // as far as looking the connector up.
    assert.match(text, /not installed/i, text);
  } finally {
    await closeTestServer(server);
    if (previous === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previous;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
});
