// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

test("Schedules and Search loading screens draw the title the finished page ends on (Search hands text to Explore)", () => {
  for (const [rel, title] of [["schedules/loading.tsx", "Schedules"], ["search/loading.tsx", "Explore"]] as const) {
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

test("Explore's loading message sits under the title, so the title does not move", () => {
  const src = readFileSync(join(ROOT, "explore/loading.tsx"), "utf8");
  assert.ok(src.indexOf("<NamedPageLoadingSkeleton") < src.indexOf("EXPLORE_LOADING_MESSAGE}"));
});

// Round 7 (F16, F17): a loading screen has the shape and trail of the page it stands in for.
test("the sign-in helper route has its own loading screen, not the run page's Sync history one", () => {
  const file = join(ROOT, "syncs/[runId]/stream/loading.tsx");
  assert.ok(existsSync(file), "syncs/[runId]/stream/loading.tsx exists");
  const src = readFileSync(file, "utf8");
  assert.doesNotMatch(src, /Sync history/);
  assert.match(src, /TitledDetailLoadingSkeleton/);
  assert.match(src, /label="the sign-in page"/);
});

test("the Apps loading screen draws rows without right-hand buttons, as the loaded rows have none", async () => {
  const src = readFileSync(join(ROOT, "grants/loading.tsx"), "utf8");
  assert.match(src, /rowAction=\{false\}/);
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { NamedPageLoadingSkeleton } = await import("./named-page-loading.tsx");
  const html = renderToStaticMarkup(React.createElement(NamedPageLoadingSkeleton, { label: "apps", rowAction: false, rows: 3, shape: "list", title: "Apps" }));
  assert.doesNotMatch(html, /h-7 w-20/);
  const withAction = renderToStaticMarkup(React.createElement(NamedPageLoadingSkeleton, { label: "apps", rows: 3, shape: "list", title: "Apps" }));
  assert.match(withAction, /h-7 w-20/);
});
