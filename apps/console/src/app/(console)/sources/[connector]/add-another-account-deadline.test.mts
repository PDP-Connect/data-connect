// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../add/add-source-catalog-read.ts", {
  namedExports: {
    readAddSourceCatalog: () =>
      new Promise(() => {
        /* Deliberately never settles: the registry is unreachable. */
      }),
    findCatalogEntry: () => null,
  },
});
mock.module("../../components/existing-sources-by-connector.ts", {
  namedExports: { existingSourcesByConnectorCatalog: () => Promise.resolve({}) },
});
mock.module("../../lib/connector-install-client.ts", {
  namedExports: { getConnectorInstallSnapshot: () => Promise.resolve(null) },
});
const { AddAnotherAccount } = await import("./add-another-account.tsx");
test("an optional catalog that never answers cannot keep the source page stream open", async () => {
  const start = performance.now();
  assert.equal(await AddAnotherAccount({ connectorKey: "gmail", deadlineMs: 5 }), null);
  assert.ok(performance.now() - start < 250);
});
