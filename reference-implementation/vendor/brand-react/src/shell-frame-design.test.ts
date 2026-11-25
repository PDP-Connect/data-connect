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

const EXPECTED_SECTION_BY_ROUTE: Record<string, "data-sources" | "apps" | "settings" | null> = {
  "/": null,
  "/audit": "apps",
  "/audit/[traceId]": "apps",
  "/connect": "apps",
  "/connect/browser-session/[connectorId]": "data-sources",
  "/connect/browser-session/[connectorId]/launch": "data-sources",
  "/connect/manual-upload/[connectorId]": "data-sources",
  "/connect/provider-auth/[connectorId]": "data-sources",
  "/connect/static-secret/[connectorId]": "data-sources",
  "/connect/static-secret/[connectorId]/status/[connectionId]": "data-sources",
  "/connect/status/[connectionId]": "data-sources",
  "/deployment": "settings",
  "/deployment/provider-apps": "settings",
  "/deployment/tokens": "settings",
  "/device-exporters": "settings",
  "/event-subscriptions": "settings",
  "/event-subscriptions/[subscriptionId]": "settings",
  "/explore": null,
  "/grants": "apps",
  "/grants/[grantId]": "apps",
  "/grants/approvals/[approvalId]": "apps",
  "/grants/bootstrap": "apps",
  "/grants/packages": "apps",
  "/grants/packages/[packageId]": "apps",
  "/grants/request": "apps",
  "/notifications": "settings",
  "/schedules": "data-sources",
  "/search": null,
  "/settings": "settings",
  "/sources": "data-sources",
  "/sources/[connector]": "data-sources",
  "/sources/[connector]/[stream]": "data-sources",
  "/sources/[connector]/[stream]/[recordKey]": "data-sources",
  "/sources/[connector]/[stream]/health": "data-sources",
  "/sources/add": "data-sources",
  "/sources/deployment": "data-sources",
  "/sources/schedules": "data-sources",
  "/sources/stream-playground": "data-sources",
  "/stream-playground": null,
  "/syncs": "data-sources",
  "/syncs/[runId]": "data-sources",
  "/syncs/[runId]/stream": "data-sources",
};

function parseOklch(value: string): [number, number, number] {
  const match = value.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  assert.ok(match, `expected an opaque OKLCH token, got ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function oklchToSrgb(value: string): [number, number, number] {
  const [lightness, chroma, hue] = parseOklch(value);
  const angle = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(angle);
  const b = chroma * Math.sin(angle);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((channel) => {
    const clipped = Math.min(1, Math.max(0, channel));
    return clipped <= 0.0031308 ? clipped * 12.92 : 1.055 * clipped ** (1 / 2.4) - 0.055;
  }) as [number, number, number];
}

function relativeLuminance(value: string): number {
  const [red, green, blue] = oklchToSrgb(value);
  const linear = [red, green, blue].map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
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
    // Light third text darkened from 0.55: rendered 11-13px text measured under 4.5:1.
    "--foreground-faint": ["oklch(0.53 0.008 60)", "oklch(0.62 0.006 80)"],
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
  assert.equal(declaration(light, "--popover"), "var(--background)");
  assert.equal(declaration(dark, "--popover"), "oklch(0.21 0.006 80)");
  assert.equal(declaration(light, "--card"), declaration(light, "--background"));
  assert.equal(declaration(dark, "--card"), declaration(dark, "--background"));
  assert.equal(declaration(light, "--scrim"), "oklch(0.15 0.01 60 / 0.5)");
  assert.equal(declaration(dark, "--scrim"), declaration(light, "--scrim"));
  assert.equal(declaration(light, "--shadow-floating"), "0 8px 24px -6px oklch(0.1 0 0 / 0.18)");
  assert.match(light, /--surface-overlay:\s*var\(--popover\)/);
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
  assert.equal(declaration(light, "--font-eyebrow"), "var(--font-sans)");
  const eyebrow = cssBlock(css, ".pdpp-eyebrow");
  assert.equal(declaration(eyebrow, "font-family"), "var(--font-sans)");
  assert.equal(declaration(eyebrow, "font-weight"), "500");
  assert.equal(declaration(eyebrow, "color"), "var(--muted-foreground)");
  assert.equal(declaration(eyebrow, "text-transform"), "none");
  assert.equal(declaration(light, "--ring"), declaration(light, "--primary"));
  assert.equal(declaration(dark, "--ring"), declaration(dark, "--primary"));
  assert.match(declaration(light, "--carbon-outline") ?? "", /245/);
  assert.match(declaration(dark, "--carbon-outline") ?? "", /238/);
  const components = await readFile(COMPONENTS_CSS, "utf8");
  assert.match(components, /\.pdpp-tooltip,\s*\.pdpp-popover\s*\{[^}]*border:\s*1px solid var\(--border-strong\)/s);
  assert.match(
    components,
    /\.pdpp-popover\s*\{\s*z-index:\s*20;\s*background:\s*var\(--popover\);\s*box-shadow:\s*var\(--shadow-floating\);/
  );
  const button = cssBlock(components, ".pdpp-btn");
  assert.match(button, /background:\s*var\(--foreground\)/);
  assert.match(button, /color:\s*var\(--background\)/);
  assert.equal(declaration(cssBlock(components, ".pdpp-select-popup"), "border-radius"), "var(--radius-control)");
  assert.equal(declaration(cssBlock(components, ".pdpp-select-popup"), "background"), "var(--popover)");
  assert.equal(declaration(cssBlock(components, ".pdpp-select-popup"), "box-shadow"), "var(--shadow-floating)");
  assert.equal(declaration(cssBlock(components, ".pdpp-dialog"), "border-radius"), "var(--radius)");
  assert.equal(declaration(cssBlock(components, ".pdpp-dialog"), "background"), "var(--popover)");
  assert.equal(declaration(cssBlock(components, ".pdpp-dialog"), "box-shadow"), "var(--shadow-floating)");
  assert.equal(declaration(cssBlock(components, ".pdpp-monogram"), "border-radius"), "26%");
  assert.equal(declaration(cssBlock(components, ".pdpp-connector-icon"), "border-radius"), "26%");
});

test("second and third text meet 4.5:1 contrast on page and menu surfaces", async () => {
  const css = await readFile(TOKENS, "utf8");
  const light = cssBlock(css, ":root");
  const dark = cssBlock(css, '[data-theme="dark"]');

  for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
    for (const textToken of ["--muted-foreground", "--foreground-faint"]) {
      // --muted is the hover and selected fill that menu rows and table rows sit on.
      for (const backgroundToken of ["--background", "--sidebar", "--muted"]) {
        const text = declaration(tokens, textToken);
        const background = declaration(tokens, backgroundToken);
        assert.ok(text && background, `${theme} ${textToken} and ${backgroundToken} tokens exist`);
        const ratio = contrastRatio(text, background);
        assert.ok(ratio >= 4.5, `${theme} ${textToken} on ${backgroundToken}: ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test("success text meets 4.5:1 contrast on page and menu surfaces", async () => {
  const css = await readFile(TOKENS, "utf8");
  // The active endorsement chip ("succeeded", "active") draws --success text; light measured 4.47:1 before.
  for (const [theme, tokens] of [["light", cssBlock(css, ":root")], ["dark", cssBlock(css, '[data-theme="dark"]')]] as const) {
    for (const backgroundToken of ["--background", "--sidebar", "--muted"]) {
      const text = declaration(tokens, "--success");
      const background = declaration(tokens, backgroundToken);
      assert.ok(text && background, `${theme} --success and ${backgroundToken} tokens exist`);
      const ratio = contrastRatio(text, background);
      assert.ok(ratio >= 4.5, `${theme} --success on ${backgroundToken}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test("frame styles use shared tokens and contain no literal colours", async () => {
  const [frame, css] = await Promise.all([readFile(FRAME, "utf8"), readFile(SHELL_CSS, "utf8")]);
  const source = `${frame}\n${css}`.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(source, /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\s*\(/i);
  assert.match(cssBlock(css, ".rr-app"), /grid-template-columns:\s*var\(--spacing-sidebar\) 1fr/);
  assert.match(cssBlock(css, ".rr-head"), /display:\s*none/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.rr-head\s*\{\s*display:\s*flex/s);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.rr-kbd\s*\{\s*display:\s*none/s);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.rr-menu-btn\s*\{[^}]*width:\s*44px;[^}]*min-height:\s*44px/s);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.pdpp-dialog\.rr-drawer \.rr-nav-item--child\s*\{\s*min-height:\s*44px/s);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.pdpp-dialog\.rr-drawer \.rr-side__theme\s*\{\s*width:\s*44px;\s*min-height:\s*44px/s);
  assert.match(cssBlock(css, ".rr-nav-item"), /min-height:\s*44px/);
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
  assert.match(source, /aria-keyshortcuts="Control\+K"/);
  assert.match(source, /aria-label="Search or jump to commands"/);
  assert.doesNotMatch(source, /aria-label=\{`Search or jump to… \$\{label\}`\}/);
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
  assert.deepEqual(routes.slice().sort(), Object.keys(EXPECTED_SECTION_BY_ROUTE).sort());
  for (const route of routes) {
    assert.equal(getSection(route), EXPECTED_SECTION_BY_ROUTE[route], route);
  }
  assert.equal(getSection("/sources/abc"), "data-sources");
  assert.equal(getSection("/syncs/123"), "data-sources");
  assert.equal(getSection("/schedules"), "data-sources");
});

test("the three floating record panels use a 1px top line", async () => {
  const components = await readFile(COMPONENTS_CSS, "utf8");
  for (const selector of [".rr-x-typeahead", ".rr-x-help__body", ".rr-x-options__body"]) {
    assert.match(declaration(cssBlock(components, selector), "border-top") ?? "", /^1px solid\s/);
  }
});

test("floating record panels use the shared popover fill and shadow", async () => {
  const components = await readFile(COMPONENTS_CSS, "utf8");
  for (const selector of [".rr-x-datechip__popover", ".rr-x-typeahead", ".rr-x-help__body", ".rr-x-options__body"]) {
    const block = cssBlock(components, selector);
    assert.equal(declaration(block, "background"), "var(--popover)", selector);
    assert.equal(declaration(block, "box-shadow"), "var(--shadow-floating)", selector);
  }
});
