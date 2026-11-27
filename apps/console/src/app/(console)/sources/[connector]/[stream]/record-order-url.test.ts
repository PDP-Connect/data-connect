// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recordOrderHref } from "./record-order-url.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROUTE_READS_ORDER = /readRecordOrder\(resolvedSearchParams\.order\)/;
const QUERY_RECORDS_RECEIVES_ORDER = /order,\s*\n\s*\}\)/;
const ACCESSIBLE_SELECT = /aria-label="sort records"/;
const NEWEST_OPTION = /<option value="desc">Newest first<\/option>/;
const OLDEST_OPTION = /<option value="asc">Oldest first<\/option>/;
const WRITES_ORDER_PARAMETER = /params\.set\("order", order\)/;

test("changing record order keeps column and field-filter choices and starts at the first page", () => {
  const href = recordOrderHref(
    "/sources/spotify/artists",
    "columns=name%2Cfollowers&filter%5Bowner_id%5D=tim&cursors=cursor-2&order=asc",
    "desc"
  );
  const url = new URL(href, "https://example.test");

  assert.equal(url.searchParams.get("order"), "desc");
  assert.equal(url.searchParams.get("columns"), "name,followers");
  assert.equal(url.searchParams.get("filter[owner_id]"), "tim");
  assert.equal(url.searchParams.has("cursors"), false);
});

test("the kind page exposes newest-first and oldest-first through the existing order query", async () => {
  const page = await readFile(`${HERE}page.tsx`, "utf8");
  const select = await readFile(`${HERE}record-order-select.tsx`, "utf8");
  const orderUrl = await readFile(`${HERE}record-order-url.ts`, "utf8");

  // data-pages.md, decision 2: the select drives the existing order parameter.
  assert.match(page, ROUTE_READS_ORDER);
  // data-pages.md, decision 2: the route passes that order to the existing query.
  assert.match(page, QUERY_RECORDS_RECEIVES_ORDER);
  // data-pages.md, decision 2: the order control is accessible and offers both directions.
  assert.match(select, ACCESSIBLE_SELECT);
  assert.match(select, NEWEST_OPTION);
  assert.match(select, OLDEST_OPTION);
  // data-pages.md, decision 2: order changes write the existing URL parameter.
  assert.match(orderUrl, WRITES_ORDER_PARAMETER);
});
