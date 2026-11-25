// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_JUMP_SHORTCUT_LABEL, jumpShortcutLabel } from "./jump-shortcut.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FRAME = `${HERE}shell-frame.tsx`;
const SHELL_CSS = `${HERE}shell.css`;
const COMPONENTS_CSS = `${HERE}components.css`;
const TOKENS = fileURLToPath(new URL("../../../../apps/console/src/styles/ink-carbon.css", import.meta.url));
const CONSOLE_ROUTES = fileURLToPath(new URL("../../../../apps/console/src/app/(console)/", import.meta.url));

function cssBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} block exists`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${selector} block closes`);
}

function declaration(block: string, name: string): string | undefined {
  return block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
}

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1).replace(/\(pathname: string\)(?:: [^{]+)?/, "(pathname)");
      }
    }
  }
  assert.fail(`${name} function closes`);
}

async function pageRoutes(directory: string, segments: string[] = []): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const routes = entries.some((entry) => entry.isFile() && entry.name === "page.tsx")
    ? [`/${segments.join("/")}`.replace(/^\/$/, "/")]
    : [];
  for (const entry of entries) {
    if (!entry.isDirectory() || ["components", "lib"].includes(entry.name)) continue;
    routes.push(...(await pageRoutes(`${directory}/${entry.name}`, [...segments, entry.name])));
  }
  return routes;
}

function expectedSection(pathname: string): "data-sources" | "apps" | "settings" | null {
  const path = pathname.replace(/\[[^\]]+\]/g, "example");
  if (["/sources", "/syncs", "/schedules"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return "data-sources";
  }
  if (path === "/connect") return "apps";
  if (path.startsWith("/connect/")) return "data-sources";
  if (["/grants", "/audit"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return "apps";
  if (["/settings", "/notifications", "/deployment", "/device-exporters", "/event-subscriptions"].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  )) {
    return "settings";
  }
  return null;
}

test("Ink Carbon assigns each direction value in light and dark", async () => {
  const css = await readFile(TOKENS, "utf8");
  const light = cssBlock(css, ":root");
  const dark = cssBlock(css, '[data-theme="dark"]');
  const expected = {
    "--background": ["oklch(0.995 0.001 90)", "oklch(0.178 0.003 80)"],
    "--sidebar": ["oklch(0.974 0.003 85)", "oklch(0.155 0.003 80)"],
    "--foreground": ["oklch(0.21 0.006 60)", "oklch(0.93 0.004 80)"],
    "--muted-foreground": ["oklch(0.46 0.008 60)", "oklch(0.70 0.006 80)"],
    "--foreground-faint": ["oklch(0.60 0.008 60)", "oklch(0.55 0.006 80)"],
    "--border": ["oklch(0.93 0.004 75)", "oklch(0.255 0.004 80)"],
    "--border-strong": ["oklch(0.87 0.005 75)", "oklch(0.33 0.005 80)"],
    "--muted": ["oklch(0.962 0.003 80)", "oklch(0.225 0.004 80)"],
    "--primary": ["oklch(0.50 0.13 245)", "oklch(0.76 0.11 238)"],
    "--attention": ["oklch(0.54 0.15 48)", "oklch(0.79 0.13 62)"],
    "--destructive": ["oklch(0.52 0.17 27)", "oklch(0.72 0.16 27)"],
  } as const;

  for (const [name, [lightValue, darkValue]] of Object.entries(expected)) {
    assert.equal(declaration(light, name), lightValue, `${name} in light mode`);
    assert.equal(declaration(dark, name), darkValue, `${name} in dark mode`);
  }
  assert.equal(declaration(light, "--radius-control"), "6px");
  assert.equal(declaration(light, "--radius"), "8px");
  assert.equal(declaration(light, "--spacing-sidebar"), "232px");
  assert.match(dark, /--surface-page:\s*var\(--background\)/);
  assert.match(dark, /--surface-card:\s*var\(--card\)/);
  assert.match(dark, /--surface-raised:\s*var\(--secondary\)/);
  assert.match(dark, /--surface-overlay:\s*var\(--popover\)/);
  assert.equal(declaration(light, "--text-title"), "26px");
  assert.equal(declaration(light, "--text-title--font-weight"), "600");
  assert.equal(declaration(light, "--text-title--letter-spacing"), "-0.022em");
  assert.match(css, /@media \(max-width: 860px\)\s*\{\s*:root\s*\{\s*--text-title:\s*23px;\s*--text-body:\s*16px/s);
  assert.match(light, /--text-eyebrow:\s*13px/);
  assert.match(light, /--text-eyebrow--font-weight:\s*500/);
  assert.match(light, /--text-eyebrow--letter-spacing:\s*0/);
  const components = await readFile(COMPONENTS_CSS, "utf8");
  const button = cssBlock(components, ".pdpp-btn");
  assert.match(button, /background:\s*var\(--foreground\)/);
  assert.match(button, /color:\s*var\(--background\)/);
  assert.equal(declaration(cssBlock(components, ".pdpp-select-popup"), "border-radius"), "var(--radius-control)");
  assert.equal(declaration(cssBlock(components, ".pdpp-dialog"), "border-radius"), "var(--radius)");
  assert.equal(declaration(cssBlock(components, ".pdpp-monogram"), "border-radius"), "26%");
  assert.equal(declaration(cssBlock(components, ".pdpp-connector-icon"), "border-radius"), "26%");
});

test("frame styles use shared tokens and contain no literal colours", async () => {
  const [frame, css] = await Promise.all([readFile(FRAME, "utf8"), readFile(SHELL_CSS, "utf8")]);
  const source = `${frame}\n${css}`.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(source, /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\s*\(/i);
  assert.match(cssBlock(css, ".rr-app"), /grid-template-columns:\s*var\(--spacing-sidebar\) 1fr/);
  assert.match(cssBlock(css, ".rr-head"), /display:\s*none/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.rr-head\s*\{\s*display:\s*flex/s);
  const phoneRules = css.slice(css.indexOf("@media (max-width: 860px)"));
  assert.doesNotMatch(phoneRules, /\.rr-kbd\s*\{[^}]*display:\s*none/);
  const sectionLabel = cssBlock(css, ".rr-side__group");
  assert.equal(declaration(sectionLabel, "font-size"), "13px");
  assert.equal(declaration(sectionLabel, "font-weight"), "500");
  assert.equal(declaration(sectionLabel, "color"), "var(--muted-foreground)");
  assert.doesNotMatch(sectionLabel, /text-transform|letter-spacing:\s*(?:0\.[1-9]|[1-9])/);
});

test("the search box shows the existing platform shortcut label", async () => {
  const source = await readFile(FRAME, "utf8");
  assert.equal(jumpShortcutLabel("Linux x86_64"), "Ctrl K");
  assert.equal(DEFAULT_JUMP_SHORTCUT_LABEL, "Ctrl K");
  assert.match(source, /className="rr-search-button"[\s\S]*?Search or jump to…[\s\S]*?className="rr-kbd">\{label\}/);
  assert.match(source, /useSyncExternalStore\(subscribeNever, clientJumpLabel, serverJumpLabel\)/);
});

test("every console page route maps to its one menu section", async () => {
  const source = await readFile(FRAME, "utf8");
  const prefixes = source.match(/const CONNECT_SOURCE_SETUP_PREFIXES = \[[\s\S]*?\];/)?.[0];
  assert.ok(prefixes, "source setup prefixes exist");
  const helper = functionSource(source, "isConnectSourceSetupRoute");
  const section = functionSource(source, "navSectionForPathname");
  const getSection = new Function(`${prefixes};${helper};${section};return navSectionForPathname;`)() as (path: string) => string | null;
  const routes = await pageRoutes(CONSOLE_ROUTES);

  assert.ok(routes.length > 0, "console page folders were found");
  for (const route of routes) {
    assert.equal(getSection(route), expectedSection(route), route);
  }
  assert.equal(getSection("/sources/abc"), "data-sources");
  assert.equal(getSection("/syncs/123"), "data-sources");
  assert.equal(getSection("/schedules"), "data-sources");
});
