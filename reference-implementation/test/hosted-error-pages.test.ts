// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/performance/useTopLevelRegex: each regex sits beside the obligation it pins.

/**
 * Browser-reachable failures must render pages, not JSON.
 *
 * Roughly thirty distinct failures on the authorize path return a raw JSON
 * body to the browser: `Unknown client_id`, `redirect_uri does not match a
 * registered redirect URI`, `code_challenge_method must be S256`, `Unknown
 * connector: <id>`, `No active connection for <id>`, `access_mode must be
 * 'single_use' or 'continuous'`, and more. An owner who hits any of them
 * mid-consent sees a JSON blob — on the most critical UI in the server.
 *
 * These pin the owner-facing page: what it says, what it must never say, and
 * that it stays a page for a browser while API clients still get their JSON.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, renderKeyValueList } from "../server/hosted-ui.ts";
import {
  type ConsentUiRenderer,
  HOSTED_DENIAL_COPY,
  prefersHtmlErrorPage,
  renderHostedErrorPage,
} from "../server/routes/as-consent-ui-helpers.ts";

const ui: ConsentUiRenderer = {
  escapeHtml,
  renderActionRow: (actions) => actions.map((a) => `<button>${escapeHtml(a.label)}</button>`).join("\n"),
  renderHostedDocument: ({ body, title }) => `<!doctype html><html><title>${escapeHtml(title)}</title><body>${body}</body></html>`,
  renderKeyValueList,
  renderPageIntro: ({ title, lede }) => `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(lede ?? "")}</p>`,
  renderResultState: ({ title, body }) => `<div>${escapeHtml(title)}${escapeHtml(body)}</div>`,
  renderSurface: ({ children }) => `<section>${children}</section>`,
};

function render(code: string, description = "", providerName = "Tim's Data Server"): string {
  return renderHostedErrorPage({ code, description, providerName, ui });
}

// ── Content negotiation: a browser gets a page, an API client gets JSON ──────

test("only a browser navigation asks for an error page", () => {
  // Browsers always send text/html in Accept on a top-level navigation; API
  // clients send application/json, or */* without text/html.
  assert.equal(prefersHtmlErrorPage("text/html,application/xhtml+xml,*/*;q=0.9"), true, "browser navigation");
  assert.equal(prefersHtmlErrorPage("application/json"), false, "API client");
  assert.equal(prefersHtmlErrorPage("*/*"), false, "curl default must keep JSON");
  assert.equal(prefersHtmlErrorPage(undefined), false, "no Accept header keeps the JSON contract");
  assert.equal(prefersHtmlErrorPage(""), false, "empty Accept keeps the JSON contract");
});

// ── The page says something the owner can act on ─────────────────────────────

test("each known failure renders owner copy, not the protocol string", () => {
  // Apostrophes arrive HTML-escaped, so match the escaped form the owner's
  // browser actually receives rather than the source string.
  const cases: Array<[string, RegExp]> = [
    ["stale_review", /This request changed since you loaded the page\. Review and approve again\./],
    ["expired_link", /This approval link expired or was already used\. Start the request again/],
    ["unknown_client", /Your server doesn&#39;t recognize this app\./],
    ["server_error", /Something went wrong on your server\. Nothing was shared\./],
  ];
  for (const [code, expected] of cases) {
    assert.match(render(code), expected, `${code} must render its owner-facing sentence`);
  }
});

test("an unmapped failure still renders a page, never a raw protocol string", () => {
  // The ~30 failures are not individually enumerable, and a new one must not
  // fall through to a blank page or to the developer's own error text.
  const html = render("invalid_request", "code_challenge_method must be S256");
  assert.match(html, /<h1[^>]*>/, "an unmapped failure still renders a real page");
  assert.match(html, /Something went wrong on your server\. Nothing was shared\./, "it falls back to the safe sentence");
  assert.equal(
    html.includes("code_challenge_method"),
    false,
    "the protocol description is for the log, never for the owner"
  );
});

test("the page never leaks protocol identifiers to the owner", () => {
  const html = render("invalid_request", "redirect_uri does not match a registered redirect URI for client_id https://chatgpt.com/oauth/abc/client.json");
  for (const leak of ["redirect_uri", "client_id", "chatgpt.com/oauth", "invalid_request"]) {
    assert.equal(html.includes(leak), false, `"${leak}" must not reach the owner surface`);
  }
});

test("the page states that nothing was shared", () => {
  // The single fact an owner most needs from a failed consent: their data did
  // not move. Every terminal failure says it.
  for (const code of ["unknown_client", "server_error", "expired_link", "boom"]) {
    assert.match(render(code), /[Nn]othing was shared|didn't get any of your data/, `${code} must reassure on data`);
  }
});

test("the error page carries the instance brand, not the protocol's", () => {
  const html = render("server_error", "", "Tim's Data Server");
  assert.match(html, /Tim&#39;s Data Server/, "the instance names the page");
  assert.equal(/<h1[^>]*>PDPP/.test(html), false, "PDPP does not headline the owner's error page");
});

test("a stale review offers a way back, not a dead end", () => {
  // The empty picker used to be a hard dead end. An error page must not
  // become the new one.
  const html = render("stale_review");
  assert.match(html, /Review and approve again/, "the owner is told what to do next");
});

// ── The denial page tells the owner what happened to their data ──────────────

test("refusal copy states the consequence, and does not say the same thing three times", () => {
  // The denial page read "Access Denied" / "Request rejected" / "The pending
  // data access request was rejected and cleared." — three ways of saying one
  // thing, in the passive voice, in protocol register, and never stating the
  // fact the owner actually wants: that their data did not move.
  assert.match(
    HOSTED_DENIAL_COPY.body,
    /didn&apos;t get any of your data|didn't get any of your data/,
    "the body names the consequence for the owner's data"
  );
  assert.match(HOSTED_DENIAL_COPY.body, /close this tab/, "the owner is told the flow is over");
  assert.equal(
    /pending|cleared|rejected/i.test(HOSTED_DENIAL_COPY.body),
    false,
    "no protocol-register restatement of the refusal"
  );
  // The result title must not simply repeat the page title.
  assert.notEqual(
    HOSTED_DENIAL_COPY.title.toLowerCase(),
    "access denied",
    "the result heading says something the H1 did not"
  );
});
