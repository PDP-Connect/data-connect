// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DeviceSteps } from "./device-steps.tsx";

test("device steps open below the sentence rather than widening the header", async () => {
  const dom = new JSDOM('<body><header id="heading"></header><p>State sentence.</p><div id="steps"></div></body>');
  Object.assign(globalThis, { React, document: dom.window.document, window: dom.window, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const heading = dom.window.document.getElementById("heading")!;
  const root = createRoot(heading);
  try {
    await act(async () => root.render(
      // biome-ignore lint/correctness/noChildrenProp: React createElement requires the component's required children in its typed props.
      createElement(DeviceSteps, { panelTargetId: "steps", children: createElement("code", null, "synthetic-command-".repeat(80)) })
    ));
    await act(async () => heading.querySelector("button")!.click());
    const panel = dom.window.document.querySelector('[role="dialog"]');
    assert.equal(panel?.parentElement?.id, "steps");
    assert.match(panel?.className ?? "", /min-w-0/);
    assert.match(panel?.className ?? "", /max-w-full/);
    assert.equal(heading.querySelector('[role="dialog"]'), null);
    await act(async () => [...panel!.querySelectorAll("button")].find((node) => node.textContent === "Close")!.click());
    assert.equal(dom.window.document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
