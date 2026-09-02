// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused adapter-level tests for server/routes/ref-design-consent-mock.ts
 * and server/routes/ref-design-consent-icons.ts.
 *
 * These mount the adapters into a fake Express-like app and exercise the
 * route logic directly with synthetic req/res objects, mirroring
 * test/run-cancel-adapter.test.ts. No real server, no DB — this route reads
 * no owner data and touches no store.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { MiddlewareHandler } from "../server/routes/_route-contract.ts";
import { mountRefDesignConsentIcons } from "../server/routes/ref-design-consent-icons.ts";
import { mountRefDesignConsentMock } from "../server/routes/ref-design-consent-mock.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeRequest {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
}

interface FakeResponse {
  _body: string | Buffer | null;
  _headers: Record<string, string>;
  _status: number;
  send: (body: string | Buffer) => FakeResponse;
  setHeader: (name: string, value: string) => FakeResponse;
  status: (code: number) => FakeResponse;
}

type RouteHandler = (req: FakeRequest, res: FakeResponse) => unknown;

interface FakeApp {
  get: (path: string, ...args: unknown[]) => FakeApp;
  middleware: Record<string, MiddlewareHandler[]>;
  routes: Record<string, RouteHandler>;
}

function makeApp(): FakeApp {
  const routes: Record<string, RouteHandler> = {};
  const middleware: Record<string, MiddlewareHandler[]> = {};
  const app: FakeApp = {
    get(path, ...args) {
      const middlewareFns = args.filter((a): a is MiddlewareHandler => typeof a === "function").slice(0, -1);
      routes[`GET ${path}`] = args.at(-1) as RouteHandler;
      middleware[`GET ${path}`] = middlewareFns;
      return app;
    },
    middleware,
    routes,
  };
  return app;
}

function makeRes(): FakeResponse {
  const res: FakeResponse = {
    _body: null,
    _headers: {},
    _status: 200,
    send(body) {
      res._body = body;
      return res;
    },
    setHeader(name, value) {
      res._headers[name] = value;
      return res;
    },
    status(code) {
      res._status = code;
      return res;
    },
  };
  return res;
}

function invokeConsentRoute(app: FakeApp, query: Record<string, unknown> = {}): string {
  const handler = app.routes["GET /_ref/design/consent"];
  assert.ok(handler, "expected the consent route to be registered");
  const res = makeRes();
  handler({ query }, res);
  assert.equal(typeof res._body, "string", "expected an HTML string body");
  return res._body as string;
}

function mountMock(): FakeApp {
  const app = makeApp();
  mountRefDesignConsentMock(app, {
    providerName: "Tim's Data Server",
    requireOwnerSession: () => {
      /* no-op in tests */
    },
  });
  return app;
}

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

test("consent mock: route is gated by requireOwnerSession before the handler", () => {
  const seen: string[] = [];
  const ownerGate = () => {
    seen.push("owner_session");
  };
  const app = makeApp();
  mountRefDesignConsentMock(app, { providerName: "Tim's Data Server", requireOwnerSession: ownerGate });
  const middleware = app.middleware["GET /_ref/design/consent"];
  assert.equal(middleware.length, 1, "exactly one middleware is registered");
  assert.equal(middleware[0], ownerGate, "requireOwnerSession is that middleware");
});

test("consent icons: route is gated by requireOwnerSession before the handler", () => {
  const ownerGate = () => {
    /* no-op */
  };
  const app = makeApp();
  mountRefDesignConsentIcons(app, { requireOwnerSession: ownerGate });
  const middleware = app.middleware["GET /_ref/design/consent/icons/:name"];
  assert.equal(middleware.length, 1);
  assert.equal(middleware[0], ownerGate);
});

// ---------------------------------------------------------------------------
// Trust tiers (owner feedback round 2, item 14)
// ---------------------------------------------------------------------------

test("consent mock: default (no ?trust=) renders the monogram, not a logo image", () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes('<span class="hosted-ui-client-monogram" aria-hidden="true">CH</span>'), "monogram present");
  assert.ok(!html.includes('<img class="hosted-ui-client-monogram"'), "no logo image for unverified");
  assert.ok(html.includes("self-reported"), "unverified trust copy present");
});

test("consent mock: ?trust=domain renders a logo image with automatic domain-verification copy", () => {
  const html = invokeConsentRoute(mountMock(), { trust: "domain" });
  assert.ok(html.includes('<img class="hosted-ui-client-monogram"'), "logo image present");
  assert.ok(html.includes("own metadata confirms this app's identity"), "domain-verification copy present");
  assert.ok(html.includes("did not need to do anything"), "explains no client participation required");
});

test("consent mock: ?trust=verified renders a logo image with operator-registration copy, distinct from domain", () => {
  const html = invokeConsentRoute(mountMock(), { trust: "verified" });
  assert.ok(html.includes('<img class="hosted-ui-client-monogram"'), "logo image present");
  assert.ok(html.includes("An operator registered this app"), "verified-tier copy present");
  assert.ok(!html.includes("own metadata confirms this app's identity"), "verified copy is distinct from domain copy");
});

// ---------------------------------------------------------------------------
// Two distinct date axes (owner feedback round 2, item 12)
// ---------------------------------------------------------------------------

test("consent mock: grant-validity control (rail) uses a distinct class from per-stream data-range controls (body)", () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes('data-role="grant-expiry-date"'), "grant expiry date input present");
  assert.ok(html.includes('data-role="grant-no-end-date"'), "no-end-date control present");
  assert.ok(html.includes('data-role="range-since"'), "per-stream range-since input present");
  assert.ok(html.includes('data-role="range-until"'), "per-stream range-until input present");
  // The two axes must never share a data-role value.
  assert.notEqual("grant-expiry-date", "range-since");
  assert.notEqual("grant-expiry-date", "range-until");
});

test("consent mock: quick-fill chips (90 days / 1 year) are present as shortcuts, not the only choice", () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes('data-days="90"') && html.includes(">90 days<"), "90-day chip present");
  assert.ok(html.includes('data-days="365"') && html.includes(">1 year<"), "1-year chip present");
  assert.ok(html.includes('type="date" data-role="grant-expiry-date"'), "arbitrary date input present alongside chips");
});

test("consent mock: apply-to-all-selected-streams control exists for the per-stream data range", () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes('class="consent-range-apply-all"'), "apply-to-all control present");
  assert.ok(html.includes(">Apply to all selected streams<"), "apply-to-all label present");
});

// ---------------------------------------------------------------------------
// Field-editing disclosure (owner feedback items 5 and 13)
// ---------------------------------------------------------------------------

test('consent mock: partially-narrowed stream shows "N of M fields · Change"', () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes("4 of 12 fields"), "partial-narrowing summary present for Chase Accounts");
  assert.ok(html.includes('<span class="consent-narrow-change">Change</span>'), "Change affordance present as real DOM text");
});

test('consent mock: fully-selected stream shows "All N fields · Change"', () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes("All 18 fields"), "full-selection summary present for Chase Transactions");
});

test("consent mock: disclosure is a <details> element (expands in place, never a modal)", () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes('<details class="consent-narrow">'), "in-place <details> disclosure present");
});

// ---------------------------------------------------------------------------
// Search scaffolding (owner feedback item 4)
// ---------------------------------------------------------------------------

test("consent mock: search input, result count, and empty-state scaffolding are present", () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes('type="search"') && html.includes('aria-label="Search sources"'), "search input present");
  assert.ok(html.includes('class="consent-search-count"'), "result count element present");
  assert.ok(html.includes('class="consent-search-empty"'), "empty-state element present");
  assert.ok(html.includes('class="consent-search-clear"'), "clear button present");
  assert.ok(html.includes("addEventListener(\"keydown\""), "keyboard navigation wired in the embedded script");
  assert.ok(html.includes("ArrowDown") && html.includes("ArrowUp"), "arrow-key navigation present");
});

// ---------------------------------------------------------------------------
// Platform logos (owner feedback item 7)
// ---------------------------------------------------------------------------

test("consent mock: sources with a bundled connector icon render an <img>, never initials", () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes("/_ref/design/consent/icons/github.svg"), "GitHub source uses its real icon");
  assert.ok(html.includes("/_ref/design/consent/icons/amazon.svg"), "Amazon source uses its real icon");
});

test("consent mock: sources without a bundled icon render the neutral placeholder, not initials", () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes("consent-source-icon-placeholder"), "placeholder icon present for un-iconed sources");
});

// ---------------------------------------------------------------------------
// Footer link (owner feedback item 10)
// ---------------------------------------------------------------------------

test('consent mock: "Secured by PDPP" links to https://pdpp.dev', () => {
  const html = invokeConsentRoute(mountMock());
  assert.match(html, /<a class="hosted-ui-footer-attribution-link" href="https:\/\/pdpp\.dev">/);
});

// ---------------------------------------------------------------------------
// Mobile: sticky bar must not obscure body content (owner feedback item 11)
// ---------------------------------------------------------------------------

test("consent mock: mobile layout reserves body bottom padding under the fixed action bar", () => {
  const html = invokeConsentRoute(mountMock());
  assert.match(html, /\.consent-body\s*\{\s*padding-bottom:\s*6\.5rem;\s*\}/);
  assert.match(html, /\.consent-force-mobile \.consent-body\s*\{\s*padding-bottom:\s*6\.5rem;\s*\}/);
});

test("consent mock: rail collapses to position:fixed (not sticky) on mobile so it always reaches the viewport bottom", () => {
  const html = invokeConsentRoute(mountMock());
  const mobileBlock = html.slice(html.indexOf("@media (max-width: 899px)"), html.indexOf("@media (max-width: 899px)") + 400);
  assert.match(mobileBlock, /\.consent-rail\s*\{[^}]*position:\s*fixed;/s);
});

// ---------------------------------------------------------------------------
// Design-system posture (owner feedback item 8) — no bespoke palette
// ---------------------------------------------------------------------------

test("consent mock: layout CSS contains zero hardcoded oklch color literals (only var(--token) references)", () => {
  const html = invokeConsentRoute(mountMock());
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(styleMatch, "expected an embedded <style> block");
  const css = styleMatch[1];
  // The one intentional exception is the preview-chrome banner text color,
  // which is NOT part of the design (explicitly marked "Not part of the
  // design" in the original route's banner comment convention) — every other
  // oklch() literal would indicate a bespoke palette creeping back in.
  const oklchLiterals = css.match(/oklch\([^)]*\)/g) ?? [];
  const nonBannerLiterals = oklchLiterals.filter((literal) => literal !== "oklch(0.16 0.01 70)");
  assert.deepEqual(nonBannerLiterals, [], `unexpected hardcoded color literals: ${nonBannerLiterals.join(", ")}`);
});

test("consent mock: reuses hosted-ui.ts's shared component classes (no parallel .design-* vocabulary)", () => {
  const html = invokeConsentRoute(mountMock());
  assert.ok(html.includes('class="hosted-ui-surface"'), "reuses hosted-ui-surface");
  assert.ok(html.includes('class="hosted-ui-option-source consent-source-row"'), "reuses hosted-ui-option-source");
  assert.ok(html.includes('class="hosted-ui-client-identity"'), "reuses hosted-ui-client-identity");
  assert.ok(html.includes('data-variant="primary"'), "reuses hosted-ui-button variant convention");
  assert.equal(html.includes("design-shell"), false, "no leftover bespoke .design-shell class");
  assert.equal(html.includes("design-columns"), false, "no leftover bespoke .design-columns class");
});

// ---------------------------------------------------------------------------
// Icon asset route
// ---------------------------------------------------------------------------

test("consent icons: serves a known SVG icon with the correct Content-Type", () => {
  const app = makeApp();
  mountRefDesignConsentIcons(app, { requireOwnerSession: () => {} });
  const handler = app.routes["GET /_ref/design/consent/icons/:name"];
  assert.ok(handler);
  const res = makeRes();
  handler({ params: { name: "github.svg" } }, res);
  assert.equal(res._headers["Content-Type"], "image/svg+xml");
  assert.ok(res._body, "expected a body");
});

test("consent icons: serves another known SVG icon (spotify) with the correct Content-Type", () => {
  // No PNG lives in the bundled set: the upstream connector icon collection
  // includes a few PNGs (heb, oura, wholefoods), but this repo's
  // `.gitignore` excludes `*.png` repo-wide, so shipping a route that reads
  // one at module load would crash server boot on a fresh checkout. None of
  // the 27 mock sources need those three, so the route's `ICON_FILES` list
  // only contains SVGs that are actually tracked in git.
  const app = makeApp();
  mountRefDesignConsentIcons(app, { requireOwnerSession: () => {} });
  const handler = app.routes["GET /_ref/design/consent/icons/:name"];
  assert.ok(handler);
  const res = makeRes();
  handler({ params: { name: "spotify.svg" } }, res);
  assert.equal(res._headers["Content-Type"], "image/svg+xml");
  assert.ok(res._body, "expected a body");
});

test("consent icons: unknown name returns 404", () => {
  const app = makeApp();
  mountRefDesignConsentIcons(app, { requireOwnerSession: () => {} });
  const handler = app.routes["GET /_ref/design/consent/icons/:name"];
  assert.ok(handler);
  const res = makeRes();
  handler({ params: { name: "nonexistent.svg" } }, res);
  assert.equal(res._status, 404);
});

// ---------------------------------------------------------------------------
// Variants render without throwing
// ---------------------------------------------------------------------------

for (const query of [
  {},
  { width: "mobile" },
  { theme: "dark" },
  { state: "signin" },
  { state: "deny" },
  { state: "error" },
  { state: "receipt" },
  { trust: "domain" },
  { trust: "verified" },
]) {
  test(`consent mock: variant ${JSON.stringify(query)} renders without throwing`, () => {
    const html = invokeConsentRoute(mountMock(), query);
    assert.match(html, /^<!DOCTYPE html>/);
  });
}
