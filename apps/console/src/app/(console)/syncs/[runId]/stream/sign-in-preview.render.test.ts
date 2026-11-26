// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as React from "react";
import * as navigation from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { flowPreview } from "../../../connect/flow-preview.ts";
Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", { namedExports: { ...navigation, useRouter: () => ({ refresh() {}, replace() {} }) } });
const viewer = import("./stream-viewer.tsx");
test("the sample browser uses the real step dock without a transport", async () => {
  const { StreamSurface } = await viewer;
  for (const previewState of ["browser-code", "browser-step", "browser-code-rejected", "stop-question"]) {
    const html = renderToStaticMarkup(React.createElement(StreamSurface, { connector: flowPreview.connector, interactionId: "sample-step", interactionKind: previewState === "browser-step" ? "manual_action" : "otp", interactionMessage: flowPreview.message, previewState, runId: flowPreview.runId }));
    assert.match(html, /Sample page, not a real sign-in/);
    assert.doesNotMatch(html, /<canvas|<video/);
    if (previewState === "browser-code") assert.match(html, /one-time-code/);
    if (previewState === "browser-step") assert.match(html, /Done/);
    if (previewState === "browser-code-rejected") assert.match(html, /did not accept that code/);
    if (previewState === "stop-question") assert.match(html, /role="alertdialog"/);
  }
});
