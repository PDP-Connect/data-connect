// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLIENT, dataRangeSummary, fieldSummary, SOURCE_ICON_FILES, SOURCES } from "./mock-data.ts";

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const PAGE_SOURCE = readFileSync(join(APP_DIR, "page.tsx"), "utf8");
const CLIENT_SOURCE = readFileSync(join(APP_DIR, "consent-preview-client.tsx"), "utf8");
const CSS_SOURCE = readFileSync(join(APP_DIR, "consent-preview.module.css"), "utf8");

// ─── Owner gating ───────────────────────────────────────────────────────────

test("design-consent-preview page calls the real DAL owner-session gate", () => {
  assert.match(PAGE_SOURCE, /verifyDashboardSession/, "must import and call the real DAL gate");
  assert.match(
    PAGE_SOURCE,
    /from ["']@\/app\/\(console\)\/lib\/verify-session\.ts["']/,
    "must import from the console's real verify-session module, not a reimplementation"
  );
  assert.match(PAGE_SOURCE, /await verifyDashboardSession\(/, "must actually call the gate, not just import it");
});

test("design-consent-preview is NOT the deliberately-ungated /design-system route", () => {
  assert.notEqual(APP_DIR.includes("design-system"), true);
});

// ─── Zero drift: real components, no hosted-ui-* legacy classes ────────────

test("consent preview uses the real @pdpp/brand-react component modules", () => {
  assert.match(CLIENT_SOURCE, /from ["']@pdpp\/brand-react["']/);
  for (const component of ["ConnectorIcon", "HumanSurface", "IcButton"]) {
    assert.match(new RegExp(`\\b${component}\\b`).test(CLIENT_SOURCE) ? "ok" : "missing", /ok/, `must import ${component}`);
  }
});

test("no hosted-ui-* class strings appear anywhere in the new consent preview source", () => {
  assert.doesNotMatch(CLIENT_SOURCE, /hosted-ui-/, "client component must not reference the retired hosted-ui.ts vocabulary");
  assert.doesNotMatch(CSS_SOURCE, /hosted-ui-/, "layout CSS must not reference the retired hosted-ui.ts vocabulary");
  assert.doesNotMatch(PAGE_SOURCE, /hosted-ui-/, "page must not reference the retired hosted-ui.ts vocabulary");
});

test("layout CSS defines no hardcoded color literals — every color is a var(--token) reference", () => {
  const colorPropertyPattern = /(?:^|;|\{)\s*(?:background|color|border(?:-\w+)?)\s*:\s*([^;]+);/gm;
  let match: RegExpExecArray | null = colorPropertyPattern.exec(CSS_SOURCE);
  const offenders: string[] = [];
  while (match) {
    const value = (match[1] ?? "").trim();
    // Structural values (none, transparent, 1px solid var(--x), inherit) are fine;
    // only flag a literal hex/rgb/hsl/oklch NOT wrapped in var(...).
    if (/#[0-9a-fA-F]{3,8}\b/.test(value) || /\b(?:rgb|rgba|hsl|hsla)\(/.test(value)) {
      offenders.push(value);
    }
    const bareOklch = value.match(/oklch\([^)]*\)/g) ?? [];
    for (const literal of bareOklch) {
      // Allowed only inside color-mix(...) alongside a var() reference (used as a
      // structural fallback for --human-tint when the token itself is undefined).
      const surrounding = value;
      if (!/var\(--/.test(surrounding)) {
        offenders.push(literal);
      }
    }
    match = colorPropertyPattern.exec(CSS_SOURCE);
  }
  assert.deepEqual(offenders, [], `found hardcoded color literal(s) outside var(--token): ${offenders.join(", ")}`);
});

// Real bug found via a real screenshot in this task's own build: on mobile,
// .railEnds (the rail's own "Access ends <date>" line) is a SIBLING of
// .grantExpiry, not nested inside it, so hiding .grantExpiry on mobile did
// not hide .railEnds — it kept rendering next to .railMobileSummary, which
// says the same thing. Same defect class as the round-2 reference-server fix
// (4dbe7fa9f). Every selector list that hides the desktop grant-validity
// block on mobile must include ALL of its sibling summary lines.
test("mobile media query hides every grant-validity summary line, not just .grantExpiry", () => {
  const mobileBlockMatch = CSS_SOURCE.match(/@media \(max-width: 899px\) \{([\s\S]*?)\n\}/);
  assert.ok(mobileBlockMatch, "expected a max-width: 899px media query block");
  const mobileBlock = mobileBlockMatch?.[1] ?? "";
  assert.match(mobileBlock, /\.railEnds\s*\{[^}]*display:\s*none/, "mobile block must hide .railEnds directly");

  const forceMobileRule = CSS_SOURCE.match(/\.forceMobile \.railSummary,[\s\S]*?\{[^}]*display:\s*none;[^}]*\}/);
  assert.ok(forceMobileRule);
  assert.match(forceMobileRule?.[0] ?? "", /\.forceMobile \.railEnds/, "the ?width=mobile force-mobile mirror must also hide .railEnds");
});

// ─── Comparability with prior rounds: same params, same 27-source dataset ──

test("mock dataset carries forward all 27 sources from the reference-server round", () => {
  assert.equal(SOURCES.length, 27);
});

test("mock client is still ChatGPT, matching the reference-server round's scenario", () => {
  assert.equal(CLIENT.name, "ChatGPT");
  assert.equal(CLIENT.domain, "chatgpt.com");
});

test("Chase and YNAB carry the CPA worked example's 2025 data range (round 2 item 12)", () => {
  const chase = SOURCES.find((s) => s.id === "chase");
  const ynab = SOURCES.find((s) => s.id === "ynab");
  assert.ok(chase);
  assert.ok(ynab);
  const chaseTx = chase?.streams.find((s) => s.name === "transactions");
  const ynabTx = ynab?.streams.find((s) => s.name === "transactions");
  assert.equal(chaseTx?.timeSince, "2025-01-01");
  assert.equal(chaseTx?.timeUntil, "2025-12-31");
  assert.equal(ynabTx?.timeSince, "2025-01-01");
  assert.equal(ynabTx?.timeUntil, "2025-12-31");
});

test("page.tsx parses the same variant query params as the reference-server round", () => {
  for (const param of ["trust", "state", "width"]) {
    assert.match(PAGE_SOURCE, new RegExp(`params\\.${param}`), `must read ?${param}=`);
  }
  for (const trustValue of ["domain", "verified"]) {
    assert.match(PAGE_SOURCE, new RegExp(`["']${trustValue}["']`));
  }
  for (const stateValue of ["signin", "deny", "error", "receipt"]) {
    assert.match(PAGE_SOURCE, new RegExp(`["']${stateValue}["']`));
  }
});

// ─── 14-item feature spot-checks ────────────────────────────────────────────

test("grant validity and per-stream data range are visually and structurally distinct controls", () => {
  assert.match(CSS_SOURCE, /\.grantExpiry\b/, "grant validity (rail) must have its own class");
  assert.match(CSS_SOURCE, /\.streamRange\b/, "per-stream data range (body) must have its own, different class");
  // Neither class name may appear as a substring of the other, and no single
  // className attribute may reference both — they must never share one element.
  assert.doesNotMatch(CSS_SOURCE, /\.grantExpiry\s*\.streamRange|\.streamRange\s*\.grantExpiry/);
  const sameElementPattern = /className=\{[^}]*styles\.grantExpiry[^}]*styles\.streamRange[^}]*\}/;
  assert.doesNotMatch(CLIENT_SOURCE, sameElementPattern, "must not conflate the two axes in one element's className");
});

test("an apply-to-all-selected-streams control exists for the per-stream data range", () => {
  assert.match(CLIENT_SOURCE, /applyRangeToAllSelected/);
  assert.match(CLIENT_SOURCE, /Apply to all selected streams/);
});

test("field disclosure reads 'N of M fields · Change', not a bare Edit link", () => {
  assert.match(CLIENT_SOURCE, /\{fieldSummary\(stream\)\}[\s\S]*Change/);
  assert.doesNotMatch(CLIENT_SOURCE, />\s*Edit\s*</, "must not use a bare Edit affordance");
});

test("three trust tiers are distinguishable in the identity component", () => {
  for (const tier of ["unverified", "domain", "verified"]) {
    assert.match(CLIENT_SOURCE, new RegExp(`trust === ["']${tier}["']`));
  }
});

test("no end date control exists alongside the arbitrary-date grant-expiry input", () => {
  assert.match(CLIENT_SOURCE, /noEndDate/);
  assert.match(CLIENT_SOURCE, /type="date"/);
  assert.match(CLIENT_SOURCE, /90 days/);
  assert.match(CLIENT_SOURCE, /1 year/);
});

test("footer links Secured by PDPP to pdpp.dev using the real PdppLogo component", () => {
  assert.match(CLIENT_SOURCE, /href="https:\/\/pdpp\.dev"/);
  assert.match(CLIENT_SOURCE, /PdppLogo/);
  assert.match(CLIENT_SOURCE, /from ["']@\/components\/pdpp-logo\.tsx["']/);
});

test("search input exists with keyboard navigation and a clear affordance", () => {
  assert.match(CLIENT_SOURCE, /aria-label="Search sources"/);
  assert.match(CLIENT_SOURCE, /ArrowDown/);
  assert.match(CLIENT_SOURCE, /ArrowUp/);
  assert.match(CLIENT_SOURCE, /Escape/);
});

// Real regression this task caught in its own build: the search/date inputs
// were rendered as bare <input>, invisible to .pdpp-input's real styling —
// zero-drift only holds if every text-like control routes through the real
// component, not just the buttons/sheets. See consent-preview-client.tsx's
// IcInput usage.
test("text-like inputs (search, date) render through the real IcInput component, not a bare <input>", () => {
  assert.match(CLIENT_SOURCE, /from ["']@pdpp\/brand-react["']/);
  const brandReactImportLine = CLIENT_SOURCE.split("\n").find((line) => line.includes('from "@pdpp/brand-react"'));
  assert.match(brandReactImportLine ?? "", /\bIcInput\b/, "IcInput must be imported from @pdpp/brand-react");
  const searchInputBlock = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('aria-label="Search sources"') - 40);
  assert.match(searchInputBlock.slice(0, 200), /<IcInput\b/, "the search input must be an IcInput element");
  const grantExpiryBlock = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('aria-label="Access ends"') - 40);
  assert.match(grantExpiryBlock.slice(0, 200), /<IcInput\b/, "the grant-expiry date input must be an IcInput element");
});

// ─── Real, on-disk icon assets ──────────────────────────────────────────────

test("every mapped source icon file actually exists on disk", () => {
  const iconsDir = join(REPO_ROOT, "reference-implementation", "server", "assets", "source-icons");
  for (const file of Object.values(SOURCE_ICON_FILES)) {
    assert.equal(existsSync(join(iconsDir, file)), true, `missing icon asset: ${file}`);
  }
});

test("icons.ts reads real files via fs, not a hand-transcribed string constant", () => {
  const iconsSource = readFileSync(join(APP_DIR, "icons.ts"), "utf8");
  assert.match(iconsSource, /readFileSync/);
  assert.doesNotMatch(iconsSource, /<svg/, "must not embed a copied SVG literal in source");
});

// ─── Pure-function behavior (fieldSummary / dataRangeSummary) ──────────────

test("fieldSummary distinguishes narrowed vs full field selection", () => {
  assert.equal(fieldSummary({ fieldsSelected: 4, fieldsTotal: 12, label: "x", name: "x", sentence: "x" }), "4 of 12 fields");
  assert.equal(fieldSummary({ fieldsTotal: 12, label: "x", name: "x", sentence: "x" }), "All 12 fields");
});

test("dataRangeSummary never mentions grant validity vocabulary", () => {
  const summary = dataRangeSummary({
    fieldsTotal: 1,
    label: "x",
    name: "x",
    sentence: "x",
    timePhrase: "Dated",
    timeSince: "2025-01-01",
    timeUntil: "2025-12-31",
  });
  assert.equal(summary, "Data from 2025-01-01 to 2025-12-31");
  assert.doesNotMatch(summary, /Access ends|No end date/);
});

// ─── Old route left untouched (owner instruction: do not delete yet) ──────

test("the old reference-server mock route is untouched in this commit", () => {
  const refRoute = join(
    REPO_ROOT,
    "reference-implementation",
    "server",
    "routes",
    "ref-design-consent-mock.ts"
  );
  assert.equal(existsSync(refRoute), true, "old route must still exist until a separate retirement commit");
});
