// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  canStartDrawerDrag,
  drawerDragAxis,
  drawerDragPosition,
  drawerDragRelease,
  drawerReleaseVelocity,
  shouldIgnoreDrawerSwipeTarget,
} from "./drawer-swipe-gesture.ts";

test("first ten pixels lock the direction for the entire gesture", () => {
  const start = { x: 100, y: 100 };
  assert.equal(drawerDragAxis(start, { x: 106, y: 106 }, "pending"), "pending");
  assert.equal(drawerDragAxis(start, { x: 110, y: 102 }, "pending"), "horizontal");
  assert.equal(drawerDragAxis(start, { x: 102, y: 110 }, "pending"), "vertical");
  assert.equal(drawerDragAxis(start, { x: 200, y: 110 }, "vertical"), "vertical");
  assert.equal(drawerDragAxis(start, { x: 102, y: 200 }, "horizontal"), "horizontal");
});

test("both Android edge zones, desktop widths, and non-touch input are excluded", () => {
  for (const x of [0, 23, 367, 390]) {
    assert.equal(canStartDrawerDrag(x, 390, "touch"), false);
  }
  for (const x of [24, 195, 366]) {
    assert.equal(canStartDrawerDrag(x, 390, "touch"), true);
  }
  assert.equal(canStartDrawerDrag(100, 861, "touch"), false);
  assert.equal(canStartDrawerDrag(100, 390, "mouse"), false);
  assert.equal(canStartDrawerDrag(100, 390, "pen"), false);
});

test("position follows travel one for one and clamps in either direction", () => {
  assert.equal(drawerDragPosition(false, 123, 300), 123);
  assert.equal(drawerDragPosition(false, -50, 300), 0);
  assert.equal(drawerDragPosition(false, 500, 300), 300);
  assert.equal(drawerDragPosition(true, -123, 300), 177);
  assert.equal(drawerDragPosition(true, -500, 300), 0);
  assert.equal(drawerDragPosition(true, 50, 300), 300);
});

test("release uses half distance or velocity toward open; a held flick expires", () => {
  assert.equal(drawerDragRelease(150, 300, 0), false);
  assert.equal(drawerDragRelease(151, 300, 0), true);
  assert.equal(drawerDragRelease(20, 300, 0.41), true);
  assert.equal(drawerDragRelease(20, 300, 0.4), false);
  assert.equal(drawerDragRelease(20, 300, -0.8), false);
  assert.equal(drawerReleaseVelocity(50, 100, 50), 0.5);
  assert.equal(drawerReleaseVelocity(50, 100, 101), 0);
  assert.equal(drawerReleaseVelocity(50, 0, 0), 0);
});

test("nested gesture owners are excluded without modifying their pages", () => {
  const dom = new JSDOM(`<main id="page">
    <pre><code id="code">code</code></pre>
    <table><tbody><tr><td id="cell">cell</td></tr></tbody></table>
    <input id="text"><textarea id="textarea"></textarea><select id="select"></select>
    <input id="range" type="range"><div role="slider" id="slider"></div>
    <div contenteditable="true" id="editable"></div><div role="textbox" id="textbox"></div>
    <div data-map id="map"></div><canvas id="canvas"></canvas><iframe id="iframe"></iframe>
    <div class="pdpp-stream-dialog"><span id="stream">browser surface</span></div>
    <div data-drawer-gesture="ignore"><span id="custom">custom control</span></div>
    <div id="scroll" style="overflow-x: auto"><span id="inside">long address</span></div>
    <div role="dialog"><a id="link" href="#">link</a></div>
  </main>`);
  const { document } = dom.window;
  Object.defineProperty(document.querySelector("#scroll"), "scrollWidth", {
    value: 400,
  });
  Object.defineProperty(document.querySelector("#scroll"), "clientWidth", {
    value: 100,
  });
  for (const id of [
    "code",
    "cell",
    "text",
    "textarea",
    "select",
    "range",
    "slider",
    "editable",
    "textbox",
    "map",
    "canvas",
    "iframe",
    "stream",
    "custom",
    "inside",
    "link",
  ]) {
    assert.equal(shouldIgnoreDrawerSwipeTarget(document.querySelector(`#${id}`)), true, id);
  }
  assert.equal(shouldIgnoreDrawerSwipeTarget(document.querySelector("#page")), false);
  assert.equal(shouldIgnoreDrawerSwipeTarget(document.querySelector("#link"), true), false);
  dom.window.close();
});
