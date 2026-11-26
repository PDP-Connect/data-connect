// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseConnectorInstallCatalogResponse } from "../../lib/connector-install-contract.ts";
import { isRegistryUnreachableCatalogError } from "../../lib/connector-install-transient.ts";
import { buildAddSourceList, notFreshCopy } from "./add-source-list-model.ts";
import { AddSourceList } from "./add-source-list.tsx";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const FETCHED_AT = "2026-11-20T15:04:00.000Z";

test("the catalog response says whether the list is fresh and when it was fetched", () => {
  const kept = parseConnectorInstallCatalogResponse({
    data: [],
    fetched_at: FETCHED_AT,
    fresh: false,
    object: "connector_install_catalog",
  });
  assert.equal(kept.fresh, false);
  assert.equal(kept.fetchedAt, FETCHED_AT);
  // A server that predates the fields only ever sent fresh lists.
  const old = parseConnectorInstallCatalogResponse({ data: [], object: "connector_install_catalog" });
  assert.equal(old.fresh, true);
  assert.equal(old.fetchedAt, null);
});

test("only a 503 from the catalog route means the registry is out of reach with no kept list", () => {
  assert.equal(
    isRegistryUnreachableCatalogError({ path: "/v1/owner/connector-install/catalog", status: 503 }),
    true
  );
  assert.equal(
    isRegistryUnreachableCatalogError({ path: "/v1/owner/connector-install/catalog", status: 500 }),
    false
  );
  assert.equal(isRegistryUnreachableCatalogError({ path: "/v1/owner/connector-install/status", status: 503 }), false);
});

test("the not-fresh line names the time and shows no codes", () => {
  assert.equal(
    notFreshCopy("Nov 20, 3:04 PM"),
    "Couldn't check for new services. Showing the list from Nov 20, 3:04 PM."
  );
  assert.equal(notFreshCopy(null), "Couldn't check for new services.");
});

test("a list that is the kept copy shows the line above the services, in local time", () => {
  const model = buildAddSourceList({
    catalog: [],
    catalogTransientlyUnavailable: true,
    existingConnectionIds: {},
    lifecycleFor: () => null,
  });
  const html = renderToStaticMarkup(<AddSourceList model={model} notFresh={{ fetchedAt: FETCHED_AT }} query="" />);
  assert.match(html, /data-testid="add-source-not-fresh"/);
  assert.match(html, /Couldn&#x27;t check for new services\. Showing the list from /);
  assert.doesNotMatch(html, /2026-11-20|T15:04|registry_unreachable|503|ghcr/);
  const fresh = renderToStaticMarkup(<AddSourceList model={model} query="" />);
  assert.doesNotMatch(fresh, /add-source-not-fresh/);
});

test("services already installed still list when the catalog leg failed", () => {
  const model = buildAddSourceList({
    catalog: [
      {
        connectorKey: "github",
        displayName: "GitHub",
        icon: null,
      } as never,
    ],
    catalogTransientlyUnavailable: true,
    existingConnectionIds: { github: ["conn_1"] },
    lifecycleFor: () => null,
  });
  assert.deepEqual(
    model.rows.map((row) => [row.displayName, row.added]),
    [["GitHub", true]]
  );
});
