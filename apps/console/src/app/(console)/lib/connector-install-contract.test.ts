// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorInstallContractError,
  parseConnectorInstallCatalogResponse,
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

test("connector-install status rejects an empty activation timestamp", () => {
  assert.throws(
    () =>
      parseConnectorInstallStatusResponse({
        ...connectorInstallStatusFixture,
        data: [{ ...connectorInstallStatusFixture.data[0], activated_at: "" }],
      }),
    /activated_at must be a non-empty string or null/
  );
});

test("connector-install client rejects an untrusted digest shape", () => {
  assert.throws(
    () =>
      parseConnectorInstallCatalogResponse({
        data: [
          {
            ...connectorInstallCatalogFixture.data[0],
            digest: "sha256:not-a-digest",
          },
        ],
        object: "connector_install_catalog",
      }),
    ConnectorInstallContractError
  );
});
