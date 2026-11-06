// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { ConnectorInstallCatalogEntry } from "../../lib/connector-install-contract.ts";

const installed: string[] = [];
let catalog: ConnectorInstallCatalogEntry[] = [];

const noop = async () => undefined;
let denyAccess = false;
mock.module("next/cache", { namedExports: { revalidatePath() {} } });
mock.module("../../lib/dashboard-access.ts", {
  namedExports: {
    requireDashboardAccess: async () => {
      if (denyAccess) {
        throw new Error("redirect:/sign-in");
      }
    },
  },
});
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

test("a package that left the catalog is reported as gone, not as superseded", async () => {
  const { installConnectorAction } = await actions;
  installed.length = 0;
  catalog = [];
  const result = await installConnectorAction("github", OLD);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.message, /no longer listed/i);
  assert.doesNotMatch(result.message, /newer/i);
  assert.deepEqual(installed, []);
});

test("a superseded digest is still reported as a newer version", async () => {
  const { installConnectorAction } = await actions;
  catalog = [row(OLD, false), row(NEW, true)];
  const result = await installConnectorAction("github", OLD);
  assert.ok(!result.ok);
  assert.match(result.message, /newer/i);
});

test("a request without dashboard access never reaches the catalog or the install call", async () => {
  const { installConnectorAction } = await actions;
  installed.length = 0;
  catalog = [row(NEW, true)];
  denyAccess = true;
  try {
    await assert.rejects(installConnectorAction("github", NEW), /redirect:\/sign-in/);
  } finally {
    denyAccess = false;
  }
  assert.deepEqual(installed, []);
});
