// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";

// The package catalog comes from a remote registry. Offline, or with a slow
// registry, that read can take tens of seconds. The "updates ready" read is
// optional, so it must give up quickly instead of holding the page open.
const neverSettles = new Promise<never>(() => {});
const updatesRead = (async () => {
  mock.module("../lib/connector-install-client.ts", {
    exports: { getConnectorInstallSnapshot: () => neverSettles },
  });
  mock.module("../components/existing-sources-by-connector.ts", {
    exports: {
      existingSourcesByConnectorCatalog: async () => ({ byConnector: {}, truncated: false, uncataloguedSources: [] }),
    },
  });
  return await import("./connector-updates-read.ts");
})();

test("the updates read gives up when the package catalog does not answer in time", async () => {
  const { readConnectorUpdates } = await updatesRead;
  const started = Date.now();
  await assert.rejects(readConnectorUpdates({ deadlineMs: 50 }), /did not answer within 50 ms/);
  assert.ok(Date.now() - started < 1000);
});

test("the Data sources page shows no updates banner when the catalog does not answer in time", async () => {
  const { readConnectorUpdates } = await updatesRead;
  const { readUpdatesReadySafely } = await import("./updates-ready-model.ts");
  assert.equal(await readUpdatesReadySafely(() => readConnectorUpdates({ deadlineMs: 50 })), null);
});

test("a data source page shows no update when the catalog does not answer in time", async () => {
  const { readConnectorUpdates } = await updatesRead;
  const { buildSourceUpdateModel } = await import("./[connector]/source-update-view-model.ts");
  assert.equal(await buildSourceUpdateModel("spotify", "Spotify", () => readConnectorUpdates({ deadlineMs: 50 })), null);
});
