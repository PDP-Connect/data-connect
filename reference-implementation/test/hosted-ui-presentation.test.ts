// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/performance/useTopLevelRegex: each regex is kept beside the obligation it pins.

/**
 * Hosted-UI presentation layer — stylesheet obligations.
 *
 * The consent screen is the most critical UI in the server, and it is the one
 * surface a real MCP client's owner ever reaches. These assertions pin the
 * presentational contract that `HOSTED_UI_CSS` owes that surface: every
 * variant the markup emits is actually styled, the page works on a phone, and
 * the stylesheet does not carry rules for markup that no longer exists.
 *
 * Every rule here is a defect that shipped: a `ghost` Cancel button that fell
 * through to the default style, a stylesheet with zero width breakpoints, an
 * accordion whose disclosure affordance shared one row with a checkbox that
 * does something different, and font families declared but never loaded.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { HOSTED_UI_CSS } from "../server/hosted-ui.ts";

// ── Button variants: every variant the markup emits must be styled ───────────

test("every button variant the hosted markup emits has a style rule", () => {
  // The picker's Cancel button renders `data-variant="ghost"`. It had no rule
  // at all, so the single refusal affordance on the consent screen fell
  // through to the default button style and read as a peer of Allow. The
  // design system reserves copper `--human` for the owner's consent act;
  // the refusal must be visibly quieter, not equally weighted.
  for (const variant of ["primary", "ghost", "danger"]) {
    assert.match(
      HOSTED_UI_CSS,
      new RegExp(`\\.hosted-ui-button\\[data-variant="${variant}"\\]`),
      `data-variant="${variant}" is emitted by hosted markup and must have a style rule`
    );
  }
});

test("the ghost refusal is quieter than the copper allow, not a second primary", () => {
  const ghostRule = /\.hosted-ui-button\[data-variant="ghost"\]\s*\{([^}]*)\}/.exec(HOSTED_UI_CSS);
  assert.ok(ghostRule, "ghost variant must have a declaration block");
  const body = ghostRule[1] ?? "";
  assert.match(body, /background:\s*transparent/, "ghost carries no filled background");
  assert.doesNotMatch(body, /var\(--human\)/, "copper is reserved for the owner's consent act — Allow alone");
});

// ── Mobile: breakpoints, touch targets, sticky actions ───────────────────────

test("the hosted stylesheet has width breakpoints, not only color-scheme queries", () => {
  // Before this, the only two `@media` blocks in the whole file were
  // `prefers-color-scheme: dark`. There was no mobile design at all on a page
  // an owner most plausibly reaches from a phone.
  const widthQueries = HOSTED_UI_CSS.match(/@media\s*\([^)]*width[^)]*\)/g) ?? [];
  assert.ok(widthQueries.length > 0, "at least one width-based breakpoint must exist");
});

test("interactive controls meet a 44px touch floor on small screens", () => {
  const mobileBlock = extractMediaBlock(HOSTED_UI_CSS, /@media\s*\(max-width:\s*600px\)/);
  assert.ok(mobileBlock, "a small-screen breakpoint must exist");
  assert.match(mobileBlock, /min-height:\s*44px/, "controls must declare the 44px touch floor");
});

test("the decision actions become a sticky bar on small screens", () => {
  // Our scope list is far longer than a 5-row GitHub scope card, so the
  // action pair must stay reachable without scrolling past the whole list.
  const mobileBlock = extractMediaBlock(HOSTED_UI_CSS, /@media\s*\(max-width:\s*600px\)/);
  assert.ok(mobileBlock, "a small-screen breakpoint must exist");
  assert.match(
    mobileBlock,
    /\.hosted-ui-decision-actions\s*\{[^}]*position:\s*sticky/,
    "the Allow/Cancel pair sticks to the bottom on mobile"
  );
});

test("fact lists stack their labels on small screens instead of squeezing the value", () => {
  // A max-content label column beside prose is a desktop shape. At 390px it
  // squeezed each value into a ~20ch gutter and wrapped every sentence to
  // five lines.
  const mobileBlock = extractMediaBlock(HOSTED_UI_CSS, /@media\s*\(max-width:\s*600px\)/);
  assert.ok(mobileBlock, "a small-screen breakpoint must exist");
  assert.match(
    mobileBlock,
    /\.hosted-ui-kv\s*\{[^}]*grid-template-columns:\s*1fr/,
    "the key/value grid collapses to one column on mobile"
  );
});

test("the disclosure chevron is its own hit target, separate from the checkbox", () => {
  // The accordion's disclosure affordance was `::after` generated text sharing
  // a row with a checkbox that does something different — on a phone, one tap
  // had two possible outcomes.
  assert.match(
    HOSTED_UI_CSS,
    /\.hosted-ui-disclosure\b/,
    "the disclosure control must be a real element with its own rule"
  );
  const rule = /\.hosted-ui-disclosure\s*\{([^}]*)\}/.exec(HOSTED_UI_CSS);
  assert.ok(rule, "disclosure must have a declaration block");
  assert.match(rule[1] ?? "", /min-(?:height|width):\s*44px/, "the chevron carries its own touch target");
});

// ── Fonts: declared families must actually load ──────────────────────────────

test("the stylesheet does not declare font families it never loads", () => {
  // `Geist` and `JetBrains Mono` were named in the font stack and never
  // imported, so every hosted page silently rendered in system UI while the
  // CSS claimed otherwise. Either self-host and load them, or name only faces
  // that actually resolve. This surface deliberately fetches no third-party
  // font CDN, so the honest choice is to declare only system fallbacks.
  const declaresWebFont = /--font-sans:[^;]*"(?:Geist|Inter)"/.test(HOSTED_UI_CSS);
  const loadsWebFont = /@font-face|@import\s+url/.test(HOSTED_UI_CSS);
  assert.equal(
    declaresWebFont && !loadsWebFont,
    false,
    "a font family named in the stack must either be loaded or not named"
  );
});

// ── Orphaned rules: no CSS for markup that no longer exists ──────────────────

test("the stylesheet carries no rules for the deleted connector badge", () => {
  // The per-row `connector` badge and the uniform source-kind summary line
  // were both removed from the markup; their rules stayed behind. Dead CSS on
  // a hand-maintained stylesheet is how the next person concludes the badge
  // still ships.
  assert.doesNotMatch(
    HOSTED_UI_CSS,
    /\.hosted-ui-option-source-kind-badge/,
    "the connector badge is gone from the markup — its rule must go too"
  );
  assert.doesNotMatch(
    HOSTED_UI_CSS,
    /\.hosted-ui-source-kind-summary/,
    "the uniform source-kind summary is gone from the markup — its rule must go too"
  );
});

/** Returns the body of the first `@media` block whose prelude matches. */
function extractMediaBlock(css: string, prelude: RegExp): string | null {
  const start = css.search(prelude);
  if (start < 0) {
    return null;
  }
  const open = css.indexOf("{", start);
  if (open < 0) {
    return null;
  }
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") {
      depth += 1;
    } else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, i);
      }
    }
  }
  return null;
}
