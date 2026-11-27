// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("../../../components/recordroom-shell-with-palette.tsx", { namedExports: { RecordroomShellWithPalette: ({ children }: { children: React.ReactNode }) => React.createElement("main", null, children) } });
mock.module("../interaction-form.tsx", { namedExports: { RunInteractionForm: () => null } });
mock.module("./no-assistance-run-poller.tsx", { namedExports: { NoAssistanceRunPoller: () => null } });

test("the sign-in page's trail names the source, not the add-a-source step", async () => {
  const { SignInFrame } = await import("./sign-in-parts.tsx");
  const html = renderToStaticMarkup(React.createElement(SignInFrame, { connector: { connectorId: "venmo", displayName: "Venmo" }, title: "Sign in to Venmo" }));
  const trail = html.match(/<nav[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.match(trail, /Home/);
  assert.match(trail, /Data sources/);
  assert.match(trail, /Venmo/);
  assert.doesNotMatch(trail, /Add a data source/);
});

// Round 10: the page header and the panel took their step from two places; one label now.
test("the sign-in header shows the step the helper is on", async () => {
  const { SignInFrame } = await import("./sign-in-parts.tsx");
  const html = renderToStaticMarkup(React.createElement(SignInFrame, { connector: { connectorId: "venmo", displayName: "Venmo" }, step: "Step 2 of 2: enter the security code", title: "Sign in to Venmo" }));
  assert.match(html, /Step 2 of 2: enter the security code/);
  assert.doesNotMatch(html, /Step 1 of 2/);
});

test("the stream page's header takes the same step label as its panel", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./stream-viewer.tsx", import.meta.url), "utf8");
  assert.match(source, /<SignInFrame connector=\{connector\} step=\{status\.display !== "trouble" \? interactionStepLabel\(interactionKind, interactionMessage\) : false\}/);
});
