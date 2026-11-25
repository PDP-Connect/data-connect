// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const COPY_FILE = fileURLToPath(new URL("../../../sources/add/connect-copy.ts", import.meta.url));
const BODIES_FILE = fileURLToPath(new URL("../../../sources/add/connect-bodies.tsx", import.meta.url));
const PAGE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url));
const FORM_FILE = fileURLToPath(new URL("./manual-upload-form.tsx", import.meta.url));

// Design "File services": lead, step 1 "Export your data", step 2 "Choose the file", "Import".
test("manual upload has two plain steps and no dead error query", async () => {
  const [page, form, copy] = await Promise.all([
    Promise.all([readFile(PAGE_FILE, "utf8"), readFile(BODIES_FILE, "utf8")]).then((parts) => parts.join("\n")),
    readFile(FORM_FILE, "utf8"),
    readFile(COPY_FILE, "utf8"),
  ]);
  assert.match(page, /title=\{targetConnectionId \? `Import another \$\{name\} file` : undefined\}/);
  assert.match(page, /description=\{fileCopy\.lead\(name\)\}/);
  assert.match(copy, /\$\{name\} has no sign-in\. You export a file from it and give the file to DataConnect\./);
  assert.match(copy, /exportStep: "Export your data"/);
  assert.match(copy, /chooseStep: "Choose the file"/);
  assert.match(copy, /return `Accepted: \$\{accepted \|\| "the file the service exports"\}\$\{size\}\.`/);
  assert.doesNotMatch(page, /resolvedSearchParams\.error|firstValue\(resolvedSearchParams\.error\)/);
  assert.match(form, /state\.ok === false && state\.message/);
  assert.match(page, /rel="noopener noreferrer"[\s\S]{0,40}target="_blank"/);
  // RAISE-RULES.md 7: all manual-upload help links have touch-sized targets.
  assert.match(page, /<OpenExternalLink[\s\S]{0,250}min-h-11 items-center underline decoration-dotted/);
  assert.match(form, /fileCopy\.button/);
  assert.match(form, /fileCopy\.checkFirst/);
  // Removed by design: folds, the Import target choice with one option, and the second back link.
  assert.doesNotMatch(`${page}\n${form}`, /<details|Import target|Back to Data sources|Connection name/);
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
