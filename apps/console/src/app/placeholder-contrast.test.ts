// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const globals = readFileSync(resolve(here, "globals.css"), "utf8");
const tokens = readFileSync(resolve(here, "../styles/ink-carbon.css"), "utf8");

function oklchToLinear([L, C, h]: [number, number, number]): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return [clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
const luminance = (rgb: [number, number, number]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
function token(scope: string, name: string): [number, number, number] {
  const block = tokens.slice(tokens.indexOf(scope));
  const match = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`).exec(block);
  assert.ok(match, `${name} in ${scope}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

test("placeholder text takes the muted-foreground token at full strength", () => {
  assert.match(globals, /::placeholder\s*\{[^}]*color:\s*var\(--muted-foreground\)\s*!important;[^}]*opacity:\s*1\s*!important/);
});

test("placeholder text reaches 4.5:1 on the field background in both themes", () => {
  for (const scope of [":root", '[data-theme="dark"]']) {
    for (const field of ["card", "background"]) {
      const ratio = contrast(oklchToLinear(token(scope, "muted-foreground")), oklchToLinear(token(scope, field)));
      assert.ok(ratio >= 4.5, `${scope} on ${field}: ${ratio.toFixed(2)}`);
    }
  }
});

// Round 9 (F10): a control's edge needs 3:1 against the page and the card; dividers keep their own softer token.
test("the control border token reaches 3:1 on the page, the card and the secondary fill in both themes", () => {
  for (const scope of [":root", '[data-theme="dark"]']) {
    for (const surface of ["background", "card", "secondary"]) {
      const ratio = contrast(oklchToLinear(token(scope, "control-border")), oklchToLinear(token(scope, surface)));
      assert.ok(ratio >= 3, `${scope} control-border on ${surface}: ${ratio.toFixed(2)}`);
    }
  }
});

test("inputs, selects and outlined buttons draw their edge with the control border, not the divider token", () => {
  const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");
  const components = read("../../../../reference-implementation/vendor/brand-react/src/components.css");
  const shell = read("../../../../reference-implementation/vendor/brand-react/src/shell.css");
  assert.doesNotMatch(components, /border(-color)?:[^;]*(?<!, )var\(--input\)/);
  assert.doesNotMatch(shell, /border(-color)?:[^;]*(?<!, )var\(--input\)/);
  assert.match(read("../../../../reference-implementation/vendor/operator-ui/src/ui/button.tsx"), /border-\[var\(--control-border\)\]/);
});

test("the sidebar search button and raw selects draw their edge with the control border", () => {
  const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");
  const shell = read("../../../../reference-implementation/vendor/brand-react/src/shell.css");
  assert.match(/\.rr-search-button \{[^}]*\}/.exec(shell)?.[0] ?? "", /border: 1px solid var\(--control-border, var\(--border\)\)/);
  for (const rel of ["(console)/audit/activity-view.tsx", "(console)/syncs/daily-syncs-view.tsx", "(console)/sources/[connector]/[stream]/record-order-select.tsx"]) {
    const source = read(rel);
    for (const select of source.match(/<select[^>]*className="[^"]*"/g) ?? []) assert.doesNotMatch(select, /border-border\b/, rel);
  }
});

test("Explore's toolbar buttons, query chevron and lens buttons, and the sources filter use the control border", () => {
  const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");
  assert.match(/\.explore-page \.rr-x-toolbar-button,[^{]*\{[^}]*\}/.exec(read("(console)/explore/explore-page.css"))?.[0] ?? "", /border: 1px solid var\(--control-border\)/);
  assert.match(/\.rr-s-filter__input \{[^}]*\}/.exec(read("(console)/sources/sources-view.css"))?.[0] ?? "", /var\(--control-border\)/);
  const components = read("../../../../reference-implementation/vendor/brand-react/src/components.css");
  for (const selector of [".rr-lens", ".rr-x-queryinput__chevron"]) {
    assert.match(new RegExp(`^\\${selector} \\{[^}]*\\}`, "m").exec(components)?.[0] ?? "", /var\(--control-border/, selector);
  }
});
