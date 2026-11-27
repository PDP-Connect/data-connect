// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as navigation from "next/navigation";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", { namedExports: { ...navigation, useRouter: () => ({ refresh() {}, replace() {} }) } });

// Round 7 (F3): the card for a lost browser kept the working-state instruction beside "Try again".
test("a lost browser's card keeps no sign-in instruction, only what happened and Try again", async () => {
  const { OrientationCard } = await import("./stream-viewer.tsx");
  const html = renderToStaticMarkup(
    React.createElement(OrientationCard, {
      buttonLabel: "Open Venmo",
      isMinting: false,
      message: "Sign in to Venmo in the browser",
      onAction() {},
      troubleMessage: "cdp websocket error",
    })
  );
  assert.match(html, /Couldn&#x27;t reach the browser\./);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /Sign in to Venmo in the browser/);
});

test("the working card still shows its instruction", async () => {
  const { OrientationCard } = await import("./stream-viewer.tsx");
  const html = renderToStaticMarkup(
    React.createElement(OrientationCard, { buttonLabel: "Open Venmo", isMinting: false, message: "Sign in to Venmo in the browser", onAction() {}, troubleMessage: null })
  );
  assert.match(html, /Sign in to Venmo in the browser/);
});
