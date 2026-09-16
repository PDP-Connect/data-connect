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
