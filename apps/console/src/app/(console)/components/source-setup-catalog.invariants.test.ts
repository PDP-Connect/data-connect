// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE_SETUP_CATALOG_FILE = fileURLToPath(new URL("./source-setup-catalog.tsx", import.meta.url));

const EXTERNAL_DOCS = /externalDocs\.map/;
const NEW_TAB = /target="_blank"/;
const NEW_TAB_TITLE = /title="Opens in a new tab"/;
const NEW_TAB_COPY = /\(opens in a new tab\)/;
const NOREFERRER = /rel="noreferrer"/;

test("source cards keep one surface and place the action after the content", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, /className="grid gap-4 rounded-sm border border-border\/80 bg-card px-4 py-4"/);
  assert.match(src, /className="mt-4 flex flex-wrap items-center gap-2 border-t border-border\/60 pt-3"/);
  assert.doesNotMatch(src, /<span className="pdpp-eyebrow text-muted-foreground">Next step<\/span>\s*<Link/);
  assert.doesNotMatch(src, /data-testid="show-development-connectors-control"[\s\S]{0,240}rounded-md border/);
});

test("source-setup-catalog renders external documentation links with new-tab forewarning", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, EXTERNAL_DOCS, "must render externalDocs links");
  assert.match(src, NEW_TAB, 'all external links must have target="_blank"');
  assert.match(src, NEW_TAB_COPY, "external documentation links must warn visibly before opening a new tab");
  assert.match(
    src,
    NEW_TAB_TITLE,
    'external documentation links must have title="Opens in a new tab" for accessibility/forewarning'
  );
  assert.match(src, NOREFERRER, 'all external links must have rel="noreferrer" for security');
});
