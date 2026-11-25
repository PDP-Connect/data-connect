// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { drawerSwipeDecision, shouldIgnoreDrawerSwipeTarget } from "./drawer-swipe-gesture.ts";

test("phone swipes open from the left content and close from the menu drawer", () => {
  assert.equal(drawerSwipeDecision({ x: 48, y: 100 }, { x: 128, y: 110 }, 180, 390, false), "open");
  assert.equal(drawerSwipeDecision({ x: 240, y: 100 }, { x: 150, y: 105 }, 180, 390, true), "close");
  assert.equal(drawerSwipeDecision({ x: 4, y: 100 }, { x: 90, y: 100 }, 160, 390, false), "nothing");
});

test("drawer swipes ignore slow, short, vertical, and desktop movement", () => {
  assert.equal(drawerSwipeDecision({ x: 48, y: 100 }, { x: 100, y: 100 }, 180, 390, false), "nothing");
  assert.equal(drawerSwipeDecision({ x: 48, y: 100 }, { x: 105, y: 130 }, 180, 390, false), "nothing");
  assert.equal(drawerSwipeDecision({ x: 48, y: 100 }, { x: 128, y: 100 }, 501, 390, false), "nothing");
  assert.equal(drawerSwipeDecision({ x: 48, y: 100 }, { x: 128, y: 100 }, 180, 861, false), "nothing");
  assert.equal(drawerSwipeDecision({ x: 240, y: 100 }, { x: 150, y: 105 }, 180, 390, false), "nothing");
});

test("swipes that begin in code, a table, a form control, or a horizontal scroller are ignored", () => {
  const dom = new JSDOM(`<div id="root">
    <pre><code id="code">code</code></pre>
    <table><tbody><tr><td id="cell">cell</td></tr></tbody></table>
    <input id="text" type="text"><input id="range" type="range">
    <div data-map id="map"></div>
    <div id="scroll" style="overflow-x: auto"><span id="inside">wide</span></div>
  </div>`);
  const { document } = dom.window;
  Object.defineProperty(document.querySelector("#scroll"), "scrollWidth", { value: 400 });
  Object.defineProperty(document.querySelector("#scroll"), "clientWidth", { value: 100 });
  assert.equal(shouldIgnoreDrawerSwipeTarget(document.querySelector("#code")), true);
  assert.equal(shouldIgnoreDrawerSwipeTarget(document.querySelector("#cell")), true);
  assert.equal(shouldIgnoreDrawerSwipeTarget(document.querySelector("#text")), true);
  assert.equal(shouldIgnoreDrawerSwipeTarget(document.querySelector("#range")), true);
  assert.equal(shouldIgnoreDrawerSwipeTarget(document.querySelector("#map")), true);
  assert.equal(shouldIgnoreDrawerSwipeTarget(document.querySelector("#inside")), true);
});

test("an open swipe inside another dialog is ignored; a close swipe inside the drawer is not", () => {
  const dom = new JSDOM(`<div role="dialog"><a id="link" href="#">link</a></div>`);
  const link = dom.window.document.querySelector("#link");
  assert.equal(shouldIgnoreDrawerSwipeTarget(link, false), true);
  assert.equal(shouldIgnoreDrawerSwipeTarget(link, true), false);
});

test("shell drawer touch listeners are passive and leave browser scrolling alone", () => {
  const shell = readFileSync(new URL("./shell-frame.tsx", import.meta.url), "utf8");
  assert.match(shell, /addEventListener\("touchstart", handleTouchStart, \{ passive: true \}\)/);
  assert.match(shell, /addEventListener\("touchend", handleTouchEnd, \{ passive: true \}\)/);
  assert.doesNotMatch(shell, /preventDefault\(/);
});
