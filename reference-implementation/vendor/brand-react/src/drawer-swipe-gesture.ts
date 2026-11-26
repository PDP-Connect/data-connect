// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface SwipePoint {
  x: number;
  y: number;
}

/** The phone breakpoint in shell.css, where the menu button shows. */
export const DRAWER_SWIPE_MAX_WIDTH = 860;

export type DragAxis = "pending" | "horizontal" | "vertical";

export function drawerDragAxis(start: SwipePoint, point: SwipePoint, axis: DragAxis): DragAxis {
  if (axis !== "pending") {
    return axis;
  }
  const x = Math.abs(point.x - start.x);
  const y = Math.abs(point.y - start.y);
  if (Math.hypot(x, y) < 10) {
    return "pending";
  }
  return x > y ? "horizontal" : "vertical";
}

export function canStartDrawerDrag(x: number, screenWidth: number, pointerType: string): boolean {
  return pointerType === "touch" && screenWidth <= DRAWER_SWIPE_MAX_WIDTH && x >= 24 && x <= screenWidth - 24;
}

export function drawerDragPosition(startOpen: boolean, travel: number, width: number): number {
  return Math.max(0, Math.min(width, (startOpen ? width : 0) + travel));
}

export function drawerDragRelease(position: number, width: number, velocity: number): boolean {
  return position > width / 2 || velocity > 0.4;
}

/** A pause before release must not turn an old flick into a new one. */
export function drawerReleaseVelocity(deltaX: number, elapsedMs: number, ageMs: number): number {
  return elapsedMs > 0 && ageMs <= 100 ? deltaX / elapsedMs : 0;
}

export function shouldIgnoreDrawerSwipeTarget(target: EventTarget | null, drawerOpen = false): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") {
    return false;
  }
  // An open swipe inside another dialog would stack the menu over it.
  if (!drawerOpen && element.closest('[role="dialog"], [role="alertdialog"]')) {
    return true;
  }
  if (
    element.closest(
      'canvas, iframe, video, .pdpp-stream-dialog, [data-drawer-gesture="ignore"], table, pre, code, input, textarea, select, map, area, [type="range"], [role="textbox"], [role="slider"], [contenteditable]:not([contenteditable="false"]), [data-map], [aria-roledescription="map"], .leaflet-container, .mapboxgl-map'
    )
  ) {
    return true;
  }

  let current: Element | null = element;
  while (current) {
    const overflowX = current.ownerDocument.defaultView?.getComputedStyle(current).overflowX;
    if ((overflowX === "auto" || overflowX === "scroll") && current.scrollWidth > current.clientWidth) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}
