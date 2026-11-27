// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function loadingFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...loadingFiles(full));
    else if (name === "loading.tsx") out.push(full);
  }
  return out;
}

test("no loading screen announces a word the finished page does not use", () => {
  const banned = /label="(this service|this run|this trace|this record|these checks|this data source|audit events)"/;
  for (const file of loadingFiles(ROOT)) {
    assert.doesNotMatch(readFileSync(file, "utf8"), banned, file);
  }
});

test("Schedules and Search loading screens draw their page's own title", () => {
  for (const [rel, title] of [["schedules/loading.tsx", "Schedules"], ["search/loading.tsx", "Search"]] as const) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.match(src, /NamedPageLoadingSkeleton/, rel);
    assert.ok(src.includes(`title="${title}"`), rel);
  }
});

test("pages with a title never load behind an untitled skeleton", () => {
  const untitled = /\b(ListLoadingSkeleton|TableLoadingSkeleton|DetailLoadingSkeleton)\b/;
  for (const rel of [
    "audit/loading.tsx",
    "explore/loading.tsx",
    "schedules/loading.tsx",
    "search/loading.tsx",
    "sources/[connector]/[stream]/loading.tsx",
    "sources/[connector]/[stream]/[recordKey]/loading.tsx",
    "grants/[grantId]/loading.tsx",
  ]) {
    assert.doesNotMatch(readFileSync(join(ROOT, rel), "utf8"), untitled, rel);
  }
});
