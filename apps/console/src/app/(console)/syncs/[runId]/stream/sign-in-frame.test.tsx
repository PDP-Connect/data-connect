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
