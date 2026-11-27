// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bindDrawerDrag } from "./drawer-drag.ts";

function fixture(open = false, reduced = true) {
  const dom = new JSDOM(
    '<body><main><button type="button">Action</button></main><div hidden inert aria-hidden="true" id="template"><nav>Menu</nav></div></body>'
  );
  const { document } = dom.window;
  Object.defineProperty(dom.window, "innerWidth", { value: 390 });
  dom.window.matchMedia = () => ({ matches: reduced }) as MediaQueryList;
  const template = document.querySelector<HTMLElement>("#template");
  const target = document.querySelector("main");
  assert.ok(template);
  assert.ok(target);
  let committed = open;
  const cleanup = bindDrawerDrag(
    template,
    () => committed,
    (value) => {
      committed = value;
    }
  );
  function pointer(type: string, x: number, y: number, time: number, pointerType = "touch") {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      pointerType: { value: pointerType },
      isPrimary: { value: true },
      clientX: { value: x },
      clientY: { value: y },
      timeStamp: { value: time },
    });
    target?.dispatchEvent(event);
  }
  function touchMove() {
    const event = new dom.window.Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: [{}] });
    target?.dispatchEvent(event);
    return event.defaultPrevented;
  }
  function click() {
    const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    target?.dispatchEvent(event);
    return event.defaultPrevented;
  }
  return {
    document,
    pointer,
    touchMove,
    click,
    open: () => committed,
    cleanup: () => {
      cleanup();
      dom.window.close();
    },
  };
}

test("vertical direction stays a native scroll; short movement stays a tap", () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", 100, 100, 0);
    f.pointer("pointermove", 102, 112, 30);
    f.pointer("pointermove", 250, 120, 60);
    assert.equal(f.touchMove(), false);
    assert.equal(f.document.querySelector(".rr-drag-panel"), null);
    f.pointer("pointerup", 250, 120, 90);
    assert.equal(f.open(), false);
    f.pointer("pointerdown", 100, 100, 100);
    f.pointer("pointermove", 105, 101, 150);
    f.pointer("pointerup", 100, 100, 200);
    assert.equal(f.click(), false);
  } finally {
    f.cleanup();
  }
});

test("a horizontal drag returned to its origin never activates the underlying action", () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", 100, 100, 0);
    f.pointer("pointermove", 180, 100, 200);
    assert.equal(f.touchMove(), true);
    f.pointer("pointermove", 100, 100, 400);
    f.pointer("pointerup", 100, 100, 600);
    assert.equal(f.open(), false);
    assert.equal(f.click(), true);
    assert.equal(f.document.querySelector(".rr-drag-panel"), null);
  } finally {
    f.cleanup();
  }
});

test("recent flick opens below half distance; a hold expires the flick", () => {
  for (const hold of [0, 200]) {
    const f = fixture();
    try {
      f.pointer("pointerdown", 100, 100, 0);
      f.pointer("pointermove", 160, 100, 80);
      f.pointer("pointerup", 160, 100, 80 + hold);
      assert.equal(f.open(), hold === 0);
    } finally {
      f.cleanup();
    }
  }
});

test("cancellation restores the original state, and cleanup removes active visuals", () => {
  const f = fixture(true);
  try {
    f.pointer("pointerdown", 250, 100, 0);
    f.pointer("pointermove", 100, 100, 200);
    f.pointer("pointercancel", 100, 100, 210);
    assert.equal(f.open(), true);
    assert.equal(f.document.querySelector(".rr-drag-panel"), null);
    f.pointer("pointerdown", 250, 100, 300);
    f.pointer("pointermove", 100, 100, 500);
    assert.ok(f.document.querySelector(".rr-drag-panel"));
  } finally {
    f.cleanup();
  }
  assert.equal(f.document.querySelector(".rr-drag-panel"), null);
  assert.equal(f.document.body.classList.contains("rr-dragging"), false);
});

test("ordinary motion retains the release position until the 200ms settle completes", async () => {
  const f = fixture(false, false);
  try {
    f.pointer("pointerdown", 100, 100, 0);
    f.pointer("pointermove", 280, 100, 400);
    f.pointer("pointerup", 280, 100, 600);
    assert.equal(f.open(), false);
    const panel = f.document.querySelector<HTMLElement>(".rr-drag-panel");
    assert.ok(panel);
    assert.ok(panel.classList.contains("rr-drag-settling"));
    assert.equal(panel.style.transform, "translateX(0px)");
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(f.open(), true);
    assert.equal(f.document.querySelector(".rr-drag-panel"), null);
  } finally {
    f.cleanup();
  }
});
