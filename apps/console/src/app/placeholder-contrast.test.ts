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
