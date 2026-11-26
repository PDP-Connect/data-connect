// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const CATALOG_READ_FILE = `${HERE}add-source-catalog-read.ts`;
const INSTALLED_SOURCES_FILE = fileURLToPath(new URL("./installed-source-catalog.ts", import.meta.url));
const SHARED_SOURCE_READER_FILE = fileURLToPath(new URL("../../components/existing-sources-by-connector.ts", import.meta.url));
const TOLERATES_REFUSAL_RE = /options\.tolerateRefusal && isContinuationRefusal\(err\)/;
const RETURNS_PARTIAL_SOURCE_ROWS_RE = /return \{ rows: \[\.\.\.rows\.values\(\)\], truncated: true \}/;

// Design "Page 1": the list that cannot load says one plain sentence and offers "Try again".
test("Add Source renders a fixed deterministic read failure before it reaches Next's error boundary", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /isDeterministicSourcesReadError\(err\)/);
  assert.match(src, /<AddSourceLoadFailed \/>/);
  assert.doesNotMatch(src, /err\.message/);
  assert.match(src, /<AddSourceHeader \/>/);
  assert.ok(
    src.indexOf("isDeterministicSourcesReadError(err)") < src.indexOf("throw err;"),
    "the known 4xx path must render before the error boundary can redact it"
  );
});

// Design "Page 1" (list of connectable services): the transient busy state keeps the list honest.
test("Add Source passes the transient package-catalog state to the list model", async () => {
  const src = await readFile(CATALOG_READ_FILE, "utf8");
  assert.match(src, /catalogTransientlyUnavailable: installSnapshot\?\.catalogUnavailableReason !== undefined/);
});

test("Add Source marks existing accounts from the shared exact reader, even when the lookup was refused part way", async () => {
  const src = await readFile(CATALOG_READ_FILE, "utf8");
  const installedSources = await readFile(INSTALLED_SOURCES_FILE, "utf8");
  const sharedReader = await readFile(SHARED_SOURCE_READER_FILE, "utf8");
  assert.match(src, /readInstalledSourceCatalog\(catalog\.map/);
  assert.match(installedSources, /return existingSourcesByConnectorCatalog\(catalogConnectorIds\)/);
  assert.match(sharedReader, TOLERATES_REFUSAL_RE);
  assert.match(sharedReader, RETURNS_PARTIAL_SOURCE_ROWS_RE);
});

// Any other failure (for example the package registry cannot be reached) lands in the segment's error
// boundary. It must keep the page's frame: navigation, title and breadcrumb, not a bare sentence.
test("Add Source's error boundary keeps the shell and the page header around the failed state", async () => {
  const src = await readFile(`${HERE}error.tsx`, "utf8");
  assert.match(src, /<RecordroomShellWithPalette>/);
  assert.match(src, /<AddSourceHeader \/>/);
  assert.match(src, /ADD_SOURCE_COPY\.loadFailed/);
});
