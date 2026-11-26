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
    findCatalogEntry: (value: AddSourceCatalogRead) => value.catalog[0],
  },
});
const actions = import("./service-ready-actions.ts");

test("a transient catalog with no install underway asks for retry instead of waiting", async () => {
  read = {
    catalog: [ynab],
    catalogNotFresh: null,
    catalogTransientlyUnavailable: true,
    existingConnectionCounts: {},
    existingConnectionIds: {},
    lifecycleFor: () => ({ catalog: null, installed: null }),
  };
  const { serviceReadinessAction } = await actions;
  assert.deepEqual(await serviceReadinessAction("ynab"), { state: "retry" });
});

test("an installed service awaiting registration still waits during a transient catalog read", async () => {
  read = {
    ...read,
    catalog: [{ ...ynab, registrationStatus: undefined }],
    lifecycleFor: () => installed("ynab"),
  };
  const { serviceReadinessAction } = await actions;
  assert.deepEqual(await serviceReadinessAction("ynab"), { state: "waiting" });
});
