// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const CATALOG_FILE = fileURLToPath(new URL("../../components/source-setup-catalog.tsx", import.meta.url));
const HANDLES_DETERMINISTIC_REQUEST_RE = /if \(isDeterministicSourcesReadError\(err\)\)/;
// RAISE-RULES 6: the failed sentence ends in one "Try again" link, not the words twice.
const RENDERS_FIXED_FAILURE_RE = /Couldn't load data sources\. <Link className="underline underline-offset-2" href="\/sources\/add">Try again<\/Link>\./;
const PRESERVES_FULL_HEADER_RE = /<AddSourceHeader \/>/;
const TRANSIENT_INSTALL_CATALOG_STATE_RE =
  /installCatalogTransientlyUnavailable = installSnapshot\?\.catalogUnavailableReason === "transient_busy";/;
const TRANSIENT_INSTALL_CATALOG_SNAPSHOT_ID_RE =
  /installCatalogBusySnapshotId = installCatalogTransientlyUnavailable \? randomUUID\(\) : null;/;
const PASSES_TRANSIENT_INSTALL_CATALOG_STATE_RE =
  /installCatalogTransientlyUnavailable=\{installCatalogTransientlyUnavailable\}/;
const PASSES_TRANSIENT_INSTALL_CATALOG_SNAPSHOT_ID_RE =
  /installCatalogBusySnapshotId=\{installCatalogBusySnapshotId\}/;
const STARTS_SUMMARY_READ_AFTER_CATALOG_RE = /const sourceRead = existingSourcesByConnectorCatalog\(catalog\.map/;
const PASSES_SUMMARY_READ_TO_PAGE_RE = /existingSourcesRead=\{existingSourcesRead\}/;

test("Add Source renders a fixed deterministic read failure before it reaches Next's error boundary", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, HANDLES_DETERMINISTIC_REQUEST_RE);
  // PAGE-RULES 4 and 6: raw server error text stays out of the page; a failure uses one plain sentence.
  assert.match(src, RENDERS_FIXED_FAILURE_RE);
  assert.doesNotMatch(src, /err\.message/);
  assert.match(src, PRESERVES_FULL_HEADER_RE);
  assert.doesNotMatch(src, /instanceof RefRequestError/);
  assert.ok(
    src.indexOf("if (isDeterministicSourcesReadError(err))") < src.indexOf("throw err;"),
    "the known 4xx path must render before the error boundary can redact it"
  );
});

test("Add Source preserves transient connector catalog-busy state for package presentation", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /import \{ randomUUID \} from "node:crypto";/);
  assert.match(src, TRANSIENT_INSTALL_CATALOG_STATE_RE);
  assert.match(src, TRANSIENT_INSTALL_CATALOG_SNAPSHOT_ID_RE);
  assert.match(src, PASSES_TRANSIENT_INSTALL_CATALOG_STATE_RE);
  assert.match(src, PASSES_TRANSIENT_INSTALL_CATALOG_SNAPSHOT_ID_RE);
});

test("Add Source warns that existing sources are missing when the lookup was refused part way", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const catalog = await readFile(CATALOG_FILE, "utf8");
  // Brief decision 8: the catalog draws before the existing-source summary resolves.
  assert.match(src, STARTS_SUMMARY_READ_AFTER_CATALOG_RE);
  assert.match(src, PASSES_SUMMARY_READ_TO_PAGE_RE);
  // Brief decision 8: a rejected summary read resolves to a fixed visible failure instead of rejecting the page.
  assert.match(src, /\(\): SourceSummaryReadResult => \(\{ ok: false \}\)/);
  assert.match(catalog, /if \(!result\.ok\)[\s\S]*?Couldn't load data sources\. Try again\./);
  assert.match(catalog, /result\.value\.truncated/);
  assert.match(catalog, /Some data sources could not be loaded/);
});
