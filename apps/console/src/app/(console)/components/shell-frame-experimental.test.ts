// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Frame = typeof import("../../../../../../reference-implementation/vendor/brand-react/src/shell-frame.tsx");

let loaded: Promise<Frame> | null = null;

// The real menu on a settings page, where the Advanced links show.
function loadFrame(): Promise<Frame> {
  loaded ??= (async () => {
    // The vendor frame compiles to classic JSX here, which reads a global React.
    Object.assign(globalThis, { React });
    mock.module("next/navigation", {
      namedExports: { usePathname: () => "/settings" },
    });
    return await import("../../../../../../reference-implementation/vendor/brand-react/src/shell-frame.tsx");
  })();
  return loaded;
}

test("the menu shows one Advanced group label above Server, Collectors and Webhooks", async () => {
  const { NAV_ITEMS, RecordroomShell } = await loadFrame();
  const advanced = NAV_ITEMS.filter((item) => item.labelBefore === "Advanced");
  assert.equal(advanced.length, 3, "Server, Collectors and Webhooks share the group label");

  const html = renderToStaticMarkup(createElement(RecordroomShell, null, "page"));
  // The sidebar and the phone drawer each render the menu; the drawer is closed in a static render.
  const sidebar = html.slice(html.indexOf('aria-label="Primary"'), html.indexOf("rr-side__spacer"));
  assert.equal((sidebar.match(/>Advanced</g) ?? []).length, 1);
  assert.doesNotMatch(sidebar, />Experimental</);
  const label = sidebar.indexOf(">Advanced<");
  for (const item of advanced) {
    const link = sidebar.indexOf(`href="${item.href}"`);
    assert.ok(link > label, `${item.label} sits below the Advanced label`);
  }
});
