// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(new URL("./page.tsx", import.meta.url));
const ENTRY_HREF_RE = /href=\{`\/audit\/\$\{encodeURIComponent\(trace\.trace_id\)\}`\}/;

test("activity gives compact filters and all four filter fields", async () => {
  const src = await readFile(PAGE, "utf8");
  // DIRECTION.md §The frame and the menu: keep the page's existing address and query behavior.
  assert.ok(src.includes("function FilterPopover"));
  assert.ok(src.includes('name="q"'));
  assert.ok(src.includes('name="status"'));
  assert.ok(src.includes('name="client_id"'));
  assert.ok(src.includes('name="provider_id"'));
});

test("a row opens its entry page at every width, with peek kept at xl", async () => {
  const src = await readFile(PAGE, "utf8");
  // DIRECTION.md §The frame and the menu: addresses stay fixed; the brief requires the full entry below xl.
  assert.match(src, ENTRY_HREF_RE);
  assert.ok(src.includes('className="hidden xl:inline-block" href={peekHref}'));
});

test("activity uses the requested sentence and keeps technical row facts folded", async () => {
  const src = await readFile(PAGE, "utf8");
  // DIRECTION.md §What the look is for: few words, with technical detail folded away.
  assert.ok(src.includes("What apps read and when."));
  assert.ok(src.includes('<summary className="cursor-pointer">Details</summary>'));
});

test("desktop peek keeps trace identifiers and raw events inside Details", async () => {
  const src = await readFile(PAGE, "utf8");
  const peek = src.slice(src.indexOf("function TracesPeekPanel"));
  // DIRECTION.md §What the look is for: raw IDs and request details stay in Details.
  assert.ok(peek.includes('<SheetTitle as="h2">Activity</SheetTitle>'));
  const detailsStart = peek.indexOf("<details>");
  const traceIdInDetails = peek.indexOf("{traceId}", detailsStart);
  assert.ok(detailsStart >= 0 && traceIdInDetails > detailsStart);
  assert.ok(!peek.includes("<SheetSerial>{traceId}</SheetSerial>"));
});
