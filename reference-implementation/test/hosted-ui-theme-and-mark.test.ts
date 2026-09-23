// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/performance/useTopLevelRegex: small semantic regex assertions are kept beside the assertion they explain.

/**
 * Unit coverage for two UNTESTED pure presentational helpers in
 * `server/hosted-ui.js`:
 *
 *   - normalizeHostedThemeChoice(value): a STRICT allowlist — returns the value
 *     only when it is exactly "light" | "dark" | "system"; everything else
 *     (unknown strings, null, mixed-case, padded) collapses to "system". It does
 *     NOT trim or lowercase, so "  DARK  " is not "dark".
 *
 *   - renderPdppMark({size, title}): builds the inline SVG brand mark. Defaults
 *     to size 28 / title "PDPP". A present title makes the mark an accessible
 *     image (`role="img"` + HTML-escaped `aria-label`); an empty title makes it
 *     decorative (`role="presentation"` + `aria-hidden="true"`, no aria-label).
 *     The title is HTML-escaped so it cannot break out of the attribute.
 *
 *   - renderDataConnectMark / renderBrandHeader: the hosted pages carry the
 *     console's DataConnect mark, byte-for-byte the same geometry as
 *     apps/console/public/brand/dataconnect-mark.svg.
 *
 * Pure — no DB, no server, no fixtures.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  normalizeHostedThemeChoice,
  renderBrandHeader,
  renderDataConnectMark,
  renderPdppMark,
} from "../server/hosted-ui.ts";

// --- normalizeHostedThemeChoice ---------------------------------------------

test("normalizeHostedThemeChoice: passes through the three exact valid choices", () => {
  assert.equal(normalizeHostedThemeChoice("light"), "light");
  assert.equal(normalizeHostedThemeChoice("dark"), "dark");
  assert.equal(normalizeHostedThemeChoice("system"), "system");
});

test('normalizeHostedThemeChoice: anything else collapses to "system"', () => {
  assert.equal(normalizeHostedThemeChoice("bogus"), "system", "unknown string");
  assert.equal(normalizeHostedThemeChoice(null), "system", "null");
  assert.equal(normalizeHostedThemeChoice(undefined), "system", "undefined");
  assert.equal(normalizeHostedThemeChoice(""), "system", "empty string");
});

test("normalizeHostedThemeChoice: match is strict (no trim / no case-fold)", () => {
  assert.equal(normalizeHostedThemeChoice("  dark  "), "system", "padded value is not accepted");
  assert.equal(normalizeHostedThemeChoice("DARK"), "system", "uppercase is not accepted");
  assert.equal(normalizeHostedThemeChoice("Light"), "system", "mixed-case is not accepted");
});

// --- renderPdppMark ---------------------------------------------------------

test('renderPdppMark: defaults to size 28 and an accessible "PDPP" label', () => {
  const svg = renderPdppMark();
  assert.match(svg, /^<svg /, "is an svg element");
  assert.ok(svg.includes('width="28" height="28"'), "default size 28");
  assert.ok(svg.includes('role="img"'), 'present title => role="img"');
  assert.ok(svg.includes('aria-label="PDPP"'), "default aria-label is PDPP");
  assert.ok(svg.includes('viewBox="0 0 200 200"'), "fixed viewBox");
});

test("renderPdppMark: honors a custom size", () => {
  const svg = renderPdppMark({ size: 40, title: "PDPP" });
  assert.ok(svg.includes('width="40" height="40"'), `custom size: ${svg.slice(0, 80)}`);
});

test("renderPdppMark: HTML-escapes the title so it cannot break the aria-label attribute", () => {
  const svg = renderPdppMark({ title: 'My <App> & "Co"' });
  assert.ok(svg.includes('aria-label="My &lt;App&gt; &amp; &quot;Co&quot;"'), `escaped label missing: ${svg}`);
  // The raw, unescaped title must NOT appear inside the attribute.
  assert.equal(svg.includes('aria-label="My <App>'), false, "raw < must not leak into the attribute");
});

test("renderPdppMark: an empty title makes the mark decorative (presentation + aria-hidden, no label)", () => {
  const svg = renderPdppMark({ title: "" });
  assert.ok(svg.includes('role="presentation"'), 'empty title => role="presentation"');
  assert.ok(svg.includes('aria-hidden="true"'), "empty title => aria-hidden");
  assert.equal(svg.includes("aria-label"), false, "no aria-label for a decorative mark");
  assert.equal(svg.includes('role="img"'), false, 'not role="img" when decorative');
});

// --- renderDataConnectMark / renderBrandHeader --------------------------------

function svgGeometry(svg: string): string[] {
  return [...svg.matchAll(/<(stop|rect|path)\b[^>]*>/g)].map((match) =>
    match[0]
      .replace(/\s*\/?>$/, "")
      .replace(/url\(#[^)]+\)/, "url(#)")
      .replace(/\s+/g, " ")
  );
}

test("renderDataConnectMark: geometry matches the console's DataConnect mark asset", () => {
  const asset = readFileSync(
    new URL("../../apps/console/public/brand/dataconnect-mark.svg", import.meta.url),
    "utf8"
  );
  const expected = svgGeometry(asset);
  assert.equal(expected.length, 6, "asset has 3 gradient stops, 1 rect, 2 paths");
  assert.deepEqual(svgGeometry(renderDataConnectMark()), expected);
});

test('renderDataConnectMark: defaults to an accessible "DataConnect" label; empty title is decorative', () => {
  assert.ok(renderDataConnectMark().includes('role="img" aria-label="DataConnect"'));
  const decorative = renderDataConnectMark({ title: "" });
  assert.ok(decorative.includes('role="presentation" aria-hidden="true"'));
  assert.equal(decorative.includes("aria-label"), false);
});

test("renderBrandHeader: the default instance name shows the product brand only", () => {
  const header = renderBrandHeader({ providerName: "DataConnect" });
  assert.ok(header.includes('<span class="hosted-ui-wordmark">DataConnect</span>'));
  assert.equal(header.includes("PDPP"), false, "no PDPP wordmark or mark label");
  assert.equal(header.includes("hosted-ui-instance-monogram"), false);
  assert.equal(header.includes("hosted-ui-provider"), false);
});

test("renderBrandHeader: a configured instance name keeps its monogram and label", () => {
  const header = renderBrandHeader({ providerName: "Tim's Data Server" });
  assert.ok(header.includes('<span class="hosted-ui-wordmark">DataConnect</span>'));
  assert.ok(header.includes('<span class="hosted-ui-instance-monogram" aria-hidden="true">TD</span>'));
  assert.ok(header.includes('<span class="hosted-ui-provider" aria-label="Provider">Tim&#39;s Data Server</span>'));
});
