// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COULDNT_REACH_BROWSER, plainBrowserTrouble } from "./browser-trouble-words.ts";

const VIEWER = fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url));

test("raw technical browser errors never reach the owner", () => {
  for (const raw of ["cdp websocket error", "WebSocket connection failed", "ECONNREFUSED 127.0.0.1:9222", "browser_surface_cdp_unreachable", "", null, undefined, "Error: socket hang up"]) {
    assert.equal(plainBrowserTrouble(raw), COULDNT_REACH_BROWSER, String(raw));
  }
});

test("a sentence the server wrote in plain words passes through", () => {
  assert.equal(plainBrowserTrouble("The browser could not start."), "The browser could not start.");
});

test("the helper says what a lost browser means, offers Try again and hides Done", async () => {
  const src = await readFile(VIEWER, "utf8");
  // Every place a browser error text is drawn goes through the one function.
  assert.match(src, /plainBrowserTrouble\(message\)/);
  assert.match(src, /plainBrowserTrouble\(error\)/);
  assert.doesNotMatch(src, /Can't show the browser/);
  assert.match(src, /LOST_BROWSER_MEANS/);
  // The dock has no Done or Continue while the browser is lost.
  assert.match(src, /browserLost/);
  // A visible "Live" beside the dot, and a tooltip on the "…" button.
  assert.match(src, /title="More actions"/);
  assert.match(src, /visibleStatusLabel/);
});
