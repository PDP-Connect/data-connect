// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url));
const FORM_FILE = fileURLToPath(new URL("./manual-upload-form.tsx", import.meta.url));

test("manual upload has three plain steps and no dead error query", async () => {
  const [page, form] = await Promise.all([readFile(PAGE_FILE, "utf8"), readFile(FORM_FILE, "utf8")]);
  assert.match(page, /targetConnectionId \? `Import another \$\{setup\.display_name\} file` : `Connect \$\{setup\.display_name\}`/);
  assert.match(page, /Upload the export file from \{setup\.display_name\}\./);
  assert.match(page, /Export your data from \{setup\.display_name\}\./);
  assert.match(page, /Choose the export file\./);
  assert.match(page, /Import the file into DataConnect\./);
  assert.doesNotMatch(page, /resolvedSearchParams\.error|firstValue\(resolvedSearchParams\.error\)/);
  assert.match(form, /state\.ok === false && state\.message/);
  assert.match(form, /rel="noopener noreferrer"[\s\S]{0,40}target="_blank"/);
  // Brief decision 3: every manual-upload help link opens in a new tab, as its label says.
  assert.equal((form.match(/<OpenExternalLink/g) ?? []).length, (form.match(/target="_blank"/g) ?? []).length);
  // RAISE-RULES.md 7: all manual-upload help links have touch-sized targets.
  assert.match(form, /<OpenExternalLink[\s\S]{0,250}min-h-11 items-center underline decoration-dotted/);
  assert.match(page, /<OpenExternalLink[\s\S]{0,250}min-h-11 items-center underline decoration-dotted/);
  assert.match(form, /Import file/);
  assert.match(form, /Preview only/);
  assert.equal((page.match(/Back to Data sources/g) ?? []).length, 1);
});

test("manual-upload copy samples avoid banned words outside Details", () => {
  const samples = [
    "Connect Google Takeout. Upload the export file from Google Takeout.",
    "Export your data. Choose the export file. Import the file into DataConnect.",
    "The file could not be checked. Try again.",
    "Import complete.",
  ];
  const banned = /\b(?:PDPP|verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i;
  for (const sample of samples) assert.doesNotMatch(sample, banned);
});
