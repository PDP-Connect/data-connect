// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { flushSync } from "react-dom";
import {
  canStartDrawerDrag,
  type DragAxis,
  drawerDragAxis,
  drawerDragPosition,
  drawerDragRelease,
  drawerReleaseVelocity,
  type SwipePoint,
  shouldIgnoreDrawerSwipeTarget,
} from "./drawer-swipe-gesture.ts";

/** Bind once to the shell. Moves write only transform/opacity, without React renders. */
export function bindDrawerDrag(template: HTMLElement, isOpen: () => boolean, commit: (open: boolean) => void) {
  const document = template.ownerDocument;
  const window = document.defaultView;
  if (!window) {
    return () => undefined;
  }
  let drag: {
    id: number;
    start: SwipePoint;
    axis: DragAxis;
    open: boolean;
    width: number;
    position: number;
    lastX: number;
    lastTime: number;
    velocity: number;
    velocityTime: number;
  } | null = null;
  let panel: HTMLElement | null = null;
  let backdrop: HTMLElement | null = null;
  let actual: HTMLElement | null = null;
  let visibility = "";
  let actualBackdrop: HTMLElement | null = null;
  let backdropVisibility = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;

  function clearVisuals() {
    if (actual) {
      actual.style.visibility = visibility;
    }
    actual = null;
    if (actualBackdrop) {
      actualBackdrop.style.visibility = backdropVisibility;
    }
    actualBackdrop = null;
    panel?.remove();
    backdrop?.remove();
    panel = null;
    backdrop = null;
    document.body.classList.remove("rr-dragging");
  }

  function paint(position: number, width: number) {
    if (panel) {
      panel.style.transform = `translateX(${position - width}px)`;
    }
    if (backdrop) {
      backdrop.style.opacity = String(position / width);
    }
  }

  function beginVisuals() {
    panel = template.cloneNode(true) as HTMLElement;
    panel.removeAttribute("hidden");
    panel.classList.add("rr-drag-panel");
    // Copies never enter the accessibility tree or become interactive.
    for (const element of panel.querySelectorAll("[id]")) {
      element.removeAttribute("id");
    }
    backdrop = document.createElement("div");
    backdrop.className = "pdpp-dialog-backdrop rr-drawer-overlay rr-drag-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.inert = true;
    document.body.append(backdrop, panel);
    actual = document.querySelector<HTMLElement>('.rr-drawer[role="dialog"]');
    if (actual) {
      ({ visibility } = actual.style);
      actual.style.visibility = "hidden";
    }
    actualBackdrop = document.querySelector<HTMLElement>(".rr-drawer-overlay:not(.rr-drag-backdrop)");
    if (actualBackdrop) {
      ({ visibility: backdropVisibility } = actualBackdrop.style);
      actualBackdrop.style.visibility = "hidden";
    }
    document.body.classList.add("rr-dragging");
  }

  function settle(open: boolean) {
    const current = drag;
    drag = null;
    if (!(current && panel)) {
      return;
    }
    suppressClick = true;
    const reduced = window?.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.classList.add("rr-drag-settling");
    backdrop?.classList.add("rr-drag-settling");
    paint(open ? current.width : 0, current.width);
    const finish = () => {
      timer = undefined;
      // Avoid replaying the ordinary dialog entrance after the visual has settled.
      document.body.classList.add("rr-drag-committed");
      flushSync(() => commit(open));
      clearVisuals();
    };
    if (reduced) {
      finish();
    } else {
      timer = setTimeout(finish, 200);
    }
  }

  function cancel() {
    if (drag?.axis === "horizontal") {
      settle(drag.open);
    } else {
      drag = null;
    }
  }

  function down(event: PointerEvent) {
    if (timer || drag) {
      cancel();
      return;
    }
    suppressClick = false;
    if (!isOpen()) {
      document.body.classList.remove("rr-drag-committed");
    }
    if (
      !(event.isPrimary && canStartDrawerDrag(event.clientX, window?.innerWidth ?? 0, event.pointerType)) ||
      shouldIgnoreDrawerSwipeTarget(event.target, isOpen())
    ) {
      return;
    }
    const open = isOpen();
    const width = Math.min(300, (window?.innerWidth ?? 0) * 0.84);
    drag = {
      id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      axis: "pending",
      open,
      width,
      position: open ? width : 0,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
      velocityTime: event.timeStamp,
    };
  }

  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    drag.axis = drawerDragAxis(drag.start, { x: event.clientX, y: event.clientY }, drag.axis);
    if (drag.axis !== "horizontal") {
      return;
    }
    // A left swipe cannot open a nonexistent right drawer.
    if (!(panel || drag.open) && event.clientX <= drag.start.x) {
      drag.axis = "vertical";
      return;
    }
    if (!panel) {
      beginVisuals();
    }
    if (event.clientX !== drag.lastX) {
      drag.velocity = drawerReleaseVelocity(event.clientX - drag.lastX, event.timeStamp - drag.lastTime, 0);
      drag.velocityTime = event.timeStamp;
      drag.lastX = event.clientX;
      drag.lastTime = event.timeStamp;
    }
    drag.position = drawerDragPosition(drag.open, event.clientX - drag.start.x, drag.width);
    paint(drag.position, drag.width);
  }

  function up(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    move(event);
    if (drag.axis !== "horizontal" || !panel) {
      drag = null;
      return;
    }
    const velocity = event.timeStamp - drag.velocityTime <= 100 ? drag.velocity : 0;
    settle(drawerDragRelease(drag.position, drag.width, velocity));
  }

  // Pointer events own tracking. Cancel touch scrolling only AFTER horizontal lock;
  // touch-action on the whole page would steal gestures from nested controls.
  function touchMove(event: TouchEvent) {
    if (event.touches.length !== 1) {
      cancel();
      return;
    }
    if (drag?.axis === "horizontal" && panel && event.cancelable) {
      event.preventDefault();
    }
  }
  function click(event: MouseEvent) {
    if (!suppressClick || event.detail === 0) {
      return;
    }
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function selection(event: Event) {
    if (panel) {
      event.preventDefault();
    }
  }
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("touchmove", touchMove, {
    passive: false,
    capture: true,
  });
  window.addEventListener("click", click, true);
  window.addEventListener("selectstart", selection, true);
  window.addEventListener("resize", cancel);
  window.addEventListener("blur", cancel);
  return () => {
    clearTimeout(timer);
    clearVisuals();
    document.body.classList.remove("rr-drag-committed");
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("touchmove", touchMove, true);
    window.removeEventListener("click", click, true);
    window.removeEventListener("selectstart", selection, true);
    window.removeEventListener("resize", cancel);
    window.removeEventListener("blur", cancel);
  };
}
