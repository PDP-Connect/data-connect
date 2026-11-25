// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { amazon, whoop, installed } from "../add/add-flow-fixtures.ts";

Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
let available = true;
let failed = false;
mock.module(new URL("../add/add-source-catalog-read.ts", import.meta.url).href, {
  namedExports: {
    readAddSourceCatalog: async () => {
      if (failed) throw new Error("offline");
      return {
        catalog: [available ? amazon : { ...whoop, connectorKey: "amazon" }],
        catalogTransientlyUnavailable: false,
        lifecycleFor: () => installed("amazon"),
      };
    },
    findCatalogEntry: (read: { catalog: typeof amazon[] }) => read.catalog[0],
  },
});

const component = import("./add-another-account.tsx");

// Repair brief 2: the source's actions include another account only when the Added row permits it.
test("an addable service offers the second-account connect page with the service name", async () => {
  available = true;
  const { AddAnotherAccount } = await component;
  const html = renderToStaticMarkup(await AddAnotherAccount({ connectorKey: "amazon" }));
  assert.match(html, />Add another Amazon account<\/a>/);
  assert.match(html, /href="\/sources\/add\/amazon"/);
});

test("a service that cannot add another account offers no action", async () => {
  available = false;
  const { AddAnotherAccount } = await component;
  assert.equal(await AddAnotherAccount({ connectorKey: "amazon" }), null);
});

test("an unavailable catalog leaves the existing source usable without offering another account", async () => {
  failed = true;
  const { AddAnotherAccount } = await component;
  assert.equal(await AddAnotherAccount({ connectorKey: "amazon" }), null);
  failed = false;
});
