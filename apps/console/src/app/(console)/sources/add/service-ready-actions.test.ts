// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { AddSourceCatalogRead } from "./add-source-catalog-read.ts";
import { installed, ynab } from "./add-flow-fixtures.ts";

let read: AddSourceCatalogRead;
mock.module("../../lib/dashboard-access.ts", { namedExports: { requireDashboardAccess: async () => undefined } });
mock.module("./add-source-catalog-read.ts", {
  namedExports: {
    readAddSourceCatalog: async () => read,
    findCatalogEntry: (value: AddSourceCatalogRead, key: string) =>
      value.catalog.find((entry) => entry.connectorKey === key) ?? null,
  },
});
const actions = import("./service-ready-actions.ts");

function transientRead(overrides: Partial<AddSourceCatalogRead>): AddSourceCatalogRead {
  return {
    catalog: [],
    catalogNotFresh: null,
    catalogTransientlyUnavailable: true,
    existingConnectionCounts: {},
    existingConnectionIds: {},
    lifecycleFor: () => ({ catalog: null, installed: null }),
    ...overrides,
  };
}

test("a transient catalog with no install underway asks for retry instead of waiting", async () => {
  read = transientRead({ catalog: [ynab] });
  const { serviceReadinessAction } = await actions;
  assert.deepEqual(await serviceReadinessAction("ynab"), { state: "retry" });
});

test("an installed service awaiting registration still waits during a transient catalog read", async () => {
  read = transientRead({
    catalog: [{ ...ynab, registrationStatus: undefined }],
    lifecycleFor: () => installed("ynab"),
  });
  const { serviceReadinessAction } = await actions;
  assert.deepEqual(await serviceReadinessAction("ynab"), { state: "waiting" });
});

test("a service missing from a transient catalog read asks for retry instead of waiting", async () => {
  read = transientRead({ catalog: [ynab] });
  const { serviceReadinessAction } = await actions;
  assert.deepEqual(await serviceReadinessAction("claude-code"), { state: "retry" });
});
