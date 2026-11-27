// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AddSourceCatalogRead } from "./add-source-catalog-read.ts";
import { installed, ynab } from "./add-flow-fixtures.ts";

Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("../../components/recordroom-shell-with-palette.tsx", {
  namedExports: { RecordroomShellWithPalette: ({ children }: { children: React.ReactNode }) => React.createElement("main", null, children) },
});
let read: AddSourceCatalogRead;
mock.module("./add-source-catalog-read.ts", {
  namedExports: {
    readAddSourceCatalog: async () => read,
    findCatalogEntry: (value: AddSourceCatalogRead, key: string) =>
      value.catalog.find((entry) => entry.connectorKey === key) ?? null,
  },
});
mock.module("./getting-ready.tsx", {
  namedExports: { GettingReady: () => React.createElement("div", { "data-testid": "getting-ready" }) },
});
const page = import("./[connector]/page.tsx");

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

test("connect page offers retry on the same service when the catalog is unavailable", async () => {
  read = transientRead({ catalog: [ynab] });
  const { default: ConnectServicePage } = await page;
  const html = renderToStaticMarkup(await ConnectServicePage({ params: Promise.resolve({ connector: "ynab" }) }));
  assert.match(html, /check for new services/);
  assert.match(html, /href="\/sources\/add\/ynab"[^>]*>Try again/);
  assert.doesNotMatch(html, /data-testid="getting-ready"/);
});

test("connect page waits for an installed service to register despite a transient catalog", async () => {
  read = transientRead({ catalog: [{ ...ynab, registrationStatus: undefined }], lifecycleFor: () => installed("ynab") });
  const { default: ConnectServicePage } = await page;
  const html = renderToStaticMarkup(await ConnectServicePage({ params: Promise.resolve({ connector: "ynab" }) }));
  assert.match(html, /data-testid="getting-ready"/);
  assert.doesNotMatch(html, /check for new services/);
});

test("connect page offers retry, not cannot-add, for a service missing from a transient catalog read", async () => {
  read = transientRead({ catalog: [ynab] });
  const { default: ConnectServicePage } = await page;
  const html = renderToStaticMarkup(await ConnectServicePage({ params: Promise.resolve({ connector: "claude-code" }) }));
  assert.match(html, /check for new services/);
  assert.match(html, /href="\/sources\/add\/claude-code"[^>]*>Try again/);
  assert.doesNotMatch(html, /data-testid="cannot-be-added-here"/);
});
