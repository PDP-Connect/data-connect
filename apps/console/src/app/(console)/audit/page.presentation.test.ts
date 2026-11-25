// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(new URL("./page.tsx", import.meta.url));
const ENTRY_PAGE = fileURLToPath(new URL("./[traceId]/page.tsx", import.meta.url));
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

test("the Activity entry names disclosed source, kind and count when present", async () => {
  const src = await readFile(ENTRY_PAGE, "utf8");
  const list = await readFile(PAGE, "utf8");
  // Brief item 1: the entry uses disclosure facts when the event provides them.
  assert.ok(src.includes("traceEntryReadFacts(events, !(cursor || envelope.truncated))"));
  assert.ok(src.includes('firstKind === "Data read" ? readFacts ?? "Data read" : firstKind'));
  assert.ok(src.includes("traceAppName(matchedTrace)"));
  assert.ok(list.includes("traceAppName(trace)"));
});

test("desktop peek shows the entry facts and links to its full entry", async () => {
  const src = await readFile(PAGE, "utf8");
  const peek = src.slice(src.indexOf("function TracesPeekPanel"));
  // Brief item 2: the side panel repeats who, what and when, then links to the full entry.
  assert.ok(peek.includes('<SheetTitle as="h2">Activity</SheetTitle>'));
  assert.ok(peek.includes('<FactRow label="Who" value={actor} />'));
  assert.ok(peek.includes('<FactRow label="What" value={what} />'));
  assert.ok(peek.includes('<FactRow label="When"'));
  assert.ok(peek.includes("Full entry →"));
  assert.ok(!peek.includes("<details>"));
  assert.equal((peek.match(/href=\{detailHref\}/g) ?? []).length, 1);
});
