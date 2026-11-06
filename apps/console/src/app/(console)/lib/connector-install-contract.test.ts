// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorInstallContractError,
  parseConnectorInstallCatalogResponse,
  parseConnectorInstallResponse,
  parseConnectorInstallStatusResponse,
} from "./connector-install-contract.ts";
import { connectorInstallCatalogFixture, connectorInstallStatusFixture } from "./connector-install-fixtures.ts";

test("connector-install client contract parses catalog fixtures without losing explicit targets", () => {
  const response = parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture);
  assert.equal(response.object, "connector_install_catalog");
  assert.equal(response.data.length, 4);
  assert.equal(response.data.find((entry) => entry.connector_id === "github" && entry.latest)?.version, "1.1.0");
  assert.deepEqual(response.data.find((entry) => entry.connector_id === "signal")?.bindings, {
    filesystem: {
      available: false,
      reason: "Install the local collector on this host.",
    },
  });
});

test("connector-install client contract parses installed status fixtures", () => {
  const response = parseConnectorInstallStatusResponse(connectorInstallStatusFixture);
  assert.equal(response.object, "connector_install_status");
  assert.equal(response.data[0]?.registry, "ghcr.io");
  assert.equal(response.data[0]?.repository, "pdp-connect/connector/github");
  assert.equal(response.data[1]?.version, "0.1.0");
});

test("connector-install mutation response unwraps its single status record", () => {
  const status = connectorInstallStatusFixture.data[0];
  assert.ok(status);
  const parsed = parseConnectorInstallResponse({
    data: status,
    object: "connector_install",
  });
  assert.equal(parsed.connector_id, status.connector_id);
  assert.equal(parsed.config_digest, status.config_digest);
  assert.equal(parsed.version, status.version);
});

test("connector-install status accepts an installed package without an activation timestamp", () => {
  const withNull = parseConnectorInstallStatusResponse({
    ...connectorInstallStatusFixture,
    data: [{ ...connectorInstallStatusFixture.data[0], activated_at: null }],
  });
  assert.equal(withNull.data[0]?.activated_at, null);

  const withoutTimestamp = { ...connectorInstallStatusFixture.data[0] };
  delete (withoutTimestamp as { activated_at?: string }).activated_at;
  const withoutValue = parseConnectorInstallStatusResponse({
    ...connectorInstallStatusFixture,
    data: [withoutTimestamp],
  });
  assert.equal(withoutValue.data[0]?.activated_at, null);
});

test("connector-install status drops an entry with an empty activation timestamp", () => {
  const parsed = parseConnectorInstallStatusResponse({
    ...connectorInstallStatusFixture,
    data: [{ ...connectorInstallStatusFixture.data[0], activated_at: "" }],
  });
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(parsed.data, []);
});

test("connector-install catalog skips an entry with an untrusted digest shape and keeps the rest", () => {
  const [first, ...rest] = connectorInstallCatalogFixture.data;
  assert.ok(first);
  const parsed = parseConnectorInstallCatalogResponse({
    data: [{ ...first, digest: "sha256:not-a-digest" }, ...rest],
    object: "connector_install_catalog",
  });
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(
    parsed.data.map((entry) => entry.digest),
    rest.map((entry) => entry.digest)
  );
});

test("connector-install status skips a malformed entry and keeps the rest", () => {
  const [first, ...rest] = connectorInstallStatusFixture.data;
  assert.ok(first);
  const parsed = parseConnectorInstallStatusResponse({
    data: [{ ...first, digest: "not-a-digest" }, ...rest],
    object: "connector_install_status",
  });
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.data.length, rest.length);
});

test("connector-install catalog still rejects a bad envelope and counts nothing skipped for a clean one", () => {
  assert.throws(
    () => parseConnectorInstallCatalogResponse({ data: "nope", object: "connector_install_catalog" }),
    ConnectorInstallContractError
  );
  assert.equal(parseConnectorInstallCatalogResponse(connectorInstallCatalogFixture).skipped, 0);
});

test("connector-install mutation response still rejects a malformed status record", () => {
  assert.throws(
    () =>
      parseConnectorInstallResponse({
        data: { ...connectorInstallStatusFixture.data[0], digest: "not-a-digest" },
        object: "connector_install",
      }),
    ConnectorInstallContractError
  );
});

test("connector-install catalog drops a mistyped cosmetic field without dropping the entry", () => {
  const [first] = connectorInstallCatalogFixture.data;
  assert.ok(first);
  const parsed = parseConnectorInstallCatalogResponse({
    ...connectorInstallCatalogFixture,
    data: [{ ...first, display_name: 123, published_at: { when: "now" } }],
  });
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.data.length, 1);
  assert.equal(parsed.data[0]?.display_name, undefined);
  assert.equal(parsed.data[0]?.published_at, undefined);
  assert.equal(parsed.data[0]?.digest, first.digest);
});
