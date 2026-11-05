// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { ConnectorInstallCatalogEntry } from "../../lib/connector-install-contract.ts";

const installed: string[] = [];
let catalog: ConnectorInstallCatalogEntry[] = [];

const noop = async () => undefined;
mock.module("next/cache", { namedExports: { revalidatePath() {} } });
mock.module("../../lib/dashboard-access.ts", { namedExports: { requireDashboardAccess: noop } });
mock.module("../../lib/connector-install-client.ts", {
  namedExports: {
    addConnectorLocalSource: noop,
    installConnector: async (input: { connectorId: string; digest: string }) => {
      installed.push(`${input.connectorId}@${input.digest}`);
    },
    listConnectorInstallCatalog: async () => catalog,
    reloadConnectorLocalSource: noop,
    removeConnectorLocalSource: noop,
    selectConnectorLocalSource: noop,
    uninstallConnector: noop,
    updateConnector: noop,
  },
});
const actions = import("./connector-install-actions.ts");

const OLD = `sha256:${"1".repeat(64)}`;
const NEW = `sha256:${"2".repeat(64)}`;

function row(digest: string, latest: boolean): ConnectorInstallCatalogEntry {
  return {
    bindings: {},
    connector_id: "github",
    connector_key: "github",
    digest,
    latest,
    version: latest ? "2.0.0" : "1.0.0",
  };
}

test("installing a digest that is no longer the latest is refused at click time", async () => {
  const { installConnectorAction } = await actions;
  installed.length = 0;
  catalog = [row(OLD, false), row(NEW, true)];
  const stale = await installConnectorAction("github", OLD);
  assert.equal(stale.ok, false);
  assert.deepEqual(installed, [], "a superseded digest must not reach the install call");
});

test("installing the current latest digest goes through", async () => {
  const { installConnectorAction } = await actions;
  installed.length = 0;
  catalog = [row(OLD, false), row(NEW, true)];
  assert.deepEqual(await installConnectorAction("github", NEW), { ok: true });
  assert.deepEqual(installed, [`github@${NEW}`]);
});
