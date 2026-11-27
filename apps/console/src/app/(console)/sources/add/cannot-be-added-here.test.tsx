// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cannotAddWhy } from "./connect-copy.ts";
import { CannotBeAddedHere } from "./connect-parts.tsx";

Object.assign(globalThis, { React });

test("a service that cannot be added has a title, the reason and what to do instead", () => {
  const why = cannotAddWhy("Venmo", "host_requirement_unmet");
  const html = renderToStaticMarkup(React.createElement(CannotBeAddedHere, { connectorKey: "venmo", instead: why.instead, name: "Venmo", reason: why.reason }));
  assert.match(html, /<h1[^>]*>.*Venmo/);
  assert.match(html, /Venmo can&#x27;t be added here yet\./);
  assert.match(html, /This computer can&#x27;t open the browser that Venmo needs for signing in\./);
  assert.match(html, /from DataConnect on a computer that can open a browser/);
  assert.match(html, /Back to all services/);
});

test("with no known reason the page says it cannot be added once, then the step", () => {
  const html = renderToStaticMarkup(React.createElement(CannotBeAddedHere, { connectorKey: "venmo", name: "Venmo" }));
  assert.equal((html.match(/can&#x27;t be added here yet|couldn&#x27;t tell/g) ?? []).length, 1);
  assert.match(html, /Pick another service from the list\./);
});

test("the trail of a Connect page ends with the page itself", async () => {
  const { ConnectHeader } = await import("./connect-parts.tsx");
  const html = renderToStaticMarkup(React.createElement(ConnectHeader, { connectorKey: "steam", icon: null, name: "Steam" }));
  const trail = html.match(/<nav[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.match(trail, /Add a data source<\/a>/);
  assert.match(trail, /Connect Steam<\/span>/);
});

// Round 7 (F7): one verdict, one name, and a retry when the text says to try again.
test("when DataConnect could not tell, the page says that once, uses the plain name, and offers Try again", () => {
  const why = cannotAddWhy("GitHub (browser session)", "inspection_unavailable");
  const html = renderToStaticMarkup(React.createElement(CannotBeAddedHere, { connectorKey: "github_browser", instead: why.instead, name: "GitHub (browser session)", reason: why.reason }));
  assert.doesNotMatch(html, /can&#x27;t be added here yet/);
  assert.equal((html.match(/couldn&#x27;t (tell|check)/g) ?? []).length, 1);
  const body = html.slice(html.indexOf('data-testid="cannot-be-added-here"'));
  assert.doesNotMatch(body, /browser session/);
  assert.match(html, /<a[^>]*href="\/sources\/add\/github_browser"[^>]*>Try again<\/a>/);
});

test("a definite block still says it cannot be added and offers no retry", () => {
  const why = cannotAddWhy("Venmo", "host_requirement_unmet");
  const html = renderToStaticMarkup(React.createElement(CannotBeAddedHere, { connectorKey: "venmo", instead: why.instead, name: "Venmo", reason: why.reason }));
  assert.match(html, /can&#x27;t be added here yet/);
  assert.doesNotMatch(html, />Try again</);
});
