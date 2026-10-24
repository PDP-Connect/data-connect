// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NAV_ITEMS } from "@pdpp/brand-react";
import type { Breadcrumb } from "@pdpp/operator-ui/components/primitives";
import { breadcrumbsFor } from "./breadcrumbs.ts";

const CONSOLE_PAGES_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SOURCES = { href: "/sources", label: "Sources" };
const DEPLOYMENT = { href: "/deployment", label: "Deployment" };
const GRANTS = { href: "/grants", label: "Grants" };
const SYNCS = { href: "/syncs", label: "Syncs" };

// Each row is a page's own route, the crumbs that page passes, and the trail
// the console must render. The three rows that name Overview are the wrong
// trails this helper replaced (deployment, connect, sources/add).
const ROUTE_TRAILS: Array<{ name: string; pathname: string; crumbs: Breadcrumb[]; expected: Breadcrumb[] }> = [
  { name: "overview has no trail", pathname: "/", crumbs: [{ label: "Overview" }], expected: [] },
  {
    name: "top-level deployment has no trail (was Overview / Deployment)",
    pathname: "/deployment",
    crumbs: [{ label: "Deployment" }],
    expected: [],
  },
  {
    name: "top-level connect apps has no trail (was Overview / Connect apps)",
    pathname: "/connect",
    crumbs: [{ label: "Connect apps" }],
    expected: [],
  },
  { name: "top-level sources has no trail", pathname: "/sources", crumbs: [{ label: "Sources" }], expected: [] },
  {
    name: "add source sits under Sources, not Overview (was Overview / Sources / Add source)",
    pathname: "/sources/add",
    crumbs: [{ label: "Add source" }],
    expected: [SOURCES, { label: "Add source" }],
  },
  {
    name: "owner tokens sit under Deployment",
    pathname: "/deployment/tokens",
    crumbs: [{ label: "Tokens" }],
    expected: [DEPLOYMENT, { label: "Tokens" }],
  },
  {
    name: "provider authorization sits under Deployment",
    pathname: "/deployment/provider-apps",
    crumbs: [{ label: "Provider authorization" }],
    expected: [DEPLOYMENT, { label: "Provider authorization" }],
  },
  {
    name: "grant request sits under Grants",
    pathname: "/grants/request",
    crumbs: [{ label: "Grant request" }],
    expected: [GRANTS, { label: "Grant request" }],
  },
  {
    name: "grant detail sits under Grants",
    pathname: "/grants/grant_1",
    crumbs: [{ label: "Grant" }],
    expected: [GRANTS, { label: "Grant" }],
  },
  {
    name: "a run keeps its source crumb when the connection is known",
    pathname: "/syncs/run_1",
    crumbs: [{ href: "/sources/conn_1", label: "Strava" }, { label: "Sync" }],
    expected: [SYNCS, { href: "/sources/conn_1", label: "Strava" }, { label: "Sync" }],
  },
  {
    name: "a run without a known connection has no source crumb",
    pathname: "/syncs/run_1",
    crumbs: [{ label: "Sync" }],
    expected: [SYNCS, { label: "Sync" }],
  },
  {
    name: "setup status keeps Sources as its section (connect carve-out)",
    pathname: "/connect/status/conn_1",
    crumbs: [{ label: "Setup status" }],
    expected: [SOURCES, { label: "Setup status" }],
  },
  {
    name: "browser-session launch keeps its parent flow under Sources",
    pathname: "/connect/browser-session/strava/launch",
    crumbs: [{ href: "/connect/browser-session/strava", label: "Connect Strava" }, { label: "Starting browser" }],
    expected: [
      SOURCES,
      { href: "/connect/browser-session/strava", label: "Connect Strava" },
      { label: "Starting browser" },
    ],
  },
  {
    name: "a source detail sits under Sources",
    pathname: "/sources/conn_1",
    crumbs: [{ label: "Strava" }],
    expected: [SOURCES, { label: "Strava" }],
  },
  {
    name: "a stream health page keeps every parent entity",
    pathname: "/sources/conn_1/activities/health",
    crumbs: [
      { href: "/sources/conn_1", label: "Strava" },
      { href: "/sources/conn_1/activities", label: "Activities" },
      { label: "health" },
    ],
    expected: [
      SOURCES,
      { href: "/sources/conn_1", label: "Strava" },
      { href: "/sources/conn_1/activities", label: "Activities" },
      { label: "health" },
    ],
  },
  {
    name: "a route outside the nav tree has no trail",
    pathname: "/search",
    crumbs: [{ label: "Jump" }],
    expected: [],
  },
  {
    name: "a prefix that does not end at a segment boundary is not nested",
    pathname: "/sourcesx/add",
    crumbs: [{ label: "Add source" }],
    expected: [],
  },
];

for (const row of ROUTE_TRAILS) {
  test(`breadcrumbs: ${row.name}`, () => {
    assert.deepEqual(breadcrumbsFor(row.pathname, ...row.crumbs), row.expected);
  });
}

test("every nav item's own route is top-level and gets no trail", () => {
  for (const item of NAV_ITEMS) {
    assert.deepEqual(breadcrumbsFor(item.href, { label: "Leaf" }), [], `${item.href} is a nav item, not nested`);
  }
});

test("every child of a nav item is nested under that item's label", () => {
  for (const item of NAV_ITEMS.filter((navItem) => navItem.href !== "/")) {
    assert.deepEqual(breadcrumbsFor(`${item.href}/child`, { label: "Leaf" }), [
      { href: item.href, label: item.label },
      { label: "Leaf" },
    ]);
  }
});

const BREADCRUMB_PROP = /breadcrumbs=\{/g;
const BREADCRUMB_VIA_HELPER = /breadcrumbs=\{\s*breadcrumbsFor\(/g;
const OVERVIEW_LABEL = /label: "Overview"/;

async function readPageSources(root: string): Promise<Array<{ file: string; src: string }>> {
  const entries = await readdir(root, { recursive: true });
  const pages = entries.filter((entry) => entry === "page.tsx" || entry.endsWith("/page.tsx"));
  return Promise.all(pages.map(async (file) => ({ file, src: await readFile(join(root, file), "utf8") })));
}

test("no console page renders a breadcrumb trail except through breadcrumbsFor", async () => {
  const pages = await readPageSources(CONSOLE_PAGES_ROOT);
  const offenders = pages
    .filter(({ src }) => (src.match(BREADCRUMB_PROP)?.length ?? 0) !== (src.match(BREADCRUMB_VIA_HELPER)?.length ?? 0))
    .map(({ file }) => file);
  assert.deepEqual(
    offenders,
    [],
    "hard-coded breadcrumb trails: pass breadcrumbs={breadcrumbsFor(pathname, ...crumbs)} instead"
  );
});

test("no console page labels a breadcrumb Overview", async () => {
  const pages = await readPageSources(CONSOLE_PAGES_ROOT);
  const offenders = pages.filter(({ src }) => OVERVIEW_LABEL.test(src)).map(({ file }) => file);
  assert.deepEqual(offenders, [], "Overview is not a breadcrumb ancestor in the nav tree");
});

// Server components call NAV_ITEMS and isNavItemActive while they render. Imported from a
// "use client" module, those names are client references that throw when called on the
// server, which is how the production build failed with `d.TD.find is not a function`.
const REPO_ROOT = new URL("../../../../../../", import.meta.url);
const BRAND_REACT_SRC = "reference-implementation/vendor/brand-react/src/";
const USE_CLIENT_DIRECTIVE = /^\s*["']use client["'];?\s*$/m;
const NAV_VALUE_EXPORT = /^export (?:const|function) (?:NAV_GROUPS|NAV_ITEMS|isNavItemActive)\b/m;
const NAV_TREE_REEXPORT = /^export \{[^}]*\bNAV_ITEMS\b[^}]*\} from "\.\/nav-tree\.ts";$/m;

test("the nav tree is a plain module that server components can call", async () => {
  const navTree = await readFile(new URL(`${BRAND_REACT_SRC}nav-tree.ts`, REPO_ROOT), "utf8");
  assert.doesNotMatch(navTree, USE_CLIENT_DIRECTIVE, "nav-tree.ts must not be a client module");
  const shellFrame = await readFile(new URL(`${BRAND_REACT_SRC}shell-frame.tsx`, REPO_ROOT), "utf8");
  assert.doesNotMatch(shellFrame, NAV_VALUE_EXPORT, "shell-frame.tsx is a client module and must not export nav values");
  const barrel = await readFile(new URL(`${BRAND_REACT_SRC}index.ts`, REPO_ROOT), "utf8");
  assert.match(barrel, NAV_TREE_REEXPORT, "the package index must export NAV_ITEMS from nav-tree.ts");
});
