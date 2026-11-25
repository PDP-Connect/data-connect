// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface SwipePoint {
  x: number;
  y: number;
}

export type DrawerSwipeDecision = "open" | "close" | "nothing";

/** The phone breakpoint in shell.css, where the menu button shows. */
export const DRAWER_SWIPE_MAX_WIDTH = 860;

export function drawerSwipeDecision(
  start: SwipePoint,
  end: SwipePoint,
  elapsedMs: number,
  screenWidth: number,
  drawerOpen: boolean,
): DrawerSwipeDecision {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (screenWidth > DRAWER_SWIPE_MAX_WIDTH || elapsedMs < 0 || elapsedMs > 500) return "nothing";
  if (Math.abs(deltaX) < 60 || Math.abs(deltaX) <= Math.abs(deltaY) * 2) return "nothing";

  if (drawerOpen) {
    const drawerWidth = Math.min(300, screenWidth * 0.84);
    return deltaX < 0 && start.x >= 24 && start.x <= drawerWidth ? "close" : "nothing";
  }
  return deltaX > 0 && start.x >= 24 && start.x < screenWidth / 2 ? "open" : "nothing";
}

export function shouldIgnoreDrawerSwipeTarget(target: EventTarget | null, drawerOpen = false): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return false;
  // An open swipe inside another dialog would stack the menu over it.
  if (!drawerOpen && element.closest('[role="dialog"], [role="alertdialog"]')) return true;
  if (element.closest('table, pre, code, input, textarea, select, map, area, [type="range"], [role="textbox"], [contenteditable]:not([contenteditable="false"]), [data-map], [aria-roledescription="map"], .leaflet-container, .mapboxgl-map')) {
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
