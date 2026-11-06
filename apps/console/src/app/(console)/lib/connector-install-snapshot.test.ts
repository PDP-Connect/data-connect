// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { connectorInstallCatalogFixture, connectorInstallStatusFixture } from "./connector-install-fixtures.ts";

let catalogPayload: unknown = connectorInstallCatalogFixture;
let statusPayload: unknown = connectorInstallStatusFixture;

mock.module("server-only", { namedExports: {} });
mock.module("./verify-session.ts", { namedExports: { verifyDashboardSession: async () => undefined } });
mock.module("./owner-token.ts", {
  namedExports: {
    getOwnerToken: async () => "token",
    getRsInternalUrl: () => "http://reference.invalid",
    ReferenceServerUnreachableError: class extends Error {},
    ResourceServerHttpError: class extends Error {},
  },
});
globalThis.fetch = (async (url: string | URL | Request) => {
  const path = String(url);
  const body = path.endsWith("/status")
    ? statusPayload
    : path.endsWith("/catalog")
      ? catalogPayload
      : { data: [], object: "connector_install_local_sources" };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status: 200 });
}) as typeof fetch;
const client = import("./connector-install-client.ts");

const CATALOG_ROWS = connectorInstallCatalogFixture.data;
const STATUS_ROWS = connectorInstallStatusFixture.data;

test("a malformed status entry fails the snapshot instead of rendering its package as not installed", async () => {
  const { getConnectorInstallSnapshot, listConnectorInstallStatus } = await client;
  const [first] = STATUS_ROWS;
  assert.ok(first);
  catalogPayload = connectorInstallCatalogFixture;
  statusPayload = { ...connectorInstallStatusFixture, data: [{ ...first, activated_at: "" }] };
  await assert.rejects(getConnectorInstallSnapshot(), /status/i);
  await assert.rejects(listConnectorInstallStatus(), /status/i);
});

test("a malformed catalog entry is skipped and counted without hiding the other packages", async () => {
  const { getConnectorInstallSnapshot } = await client;
  const [first, ...rest] = CATALOG_ROWS;
  assert.ok(first);
  catalogPayload = { ...connectorInstallCatalogFixture, data: [{ ...first, digest: "sha256:not-a-digest" }, ...rest] };
  statusPayload = connectorInstallStatusFixture;
  const snapshot = await getConnectorInstallSnapshot();
  assert.equal(snapshot.catalog.length, rest.length);
  assert.equal(snapshot.skippedEntries, 1);
});
