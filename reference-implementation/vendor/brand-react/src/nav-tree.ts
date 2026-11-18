// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The console's navigation tree: the items the sidebar renders, and the matcher that
 * marks the active one.
 *
 * Keep this a plain module. Server components import NAV_ITEMS and isNavItemActive (the
 * breadcrumb helper does). A server component that imports from a client module gets
 * client references, and calling those throws. shell-frame.tsx is the client module;
 * it imports this file for the sidebar.
 */

// SYNCS_NOTE: the owner-facing "Syncs" group item has no dedicated real route;
// it points at the real Runs route, whose page title is also Syncs.

export interface NavItem {
  /** Real route href (pinned by redirects/tests). */
  href: string;
  /** Display label (design vocabulary where it maps). */
  label: string;
}

export interface NavGroup {
  /** Group heading; null for the ungrouped orientation items. */
  heading: string | null;
  items: NavItem[];
}

/**
 * The grouped nav. Routes are the REAL clean console routes (top-level nouns
 * off root, per `redesign-owner-console-product-experience` §10.B); labels
 * follow the design vocabulary. Edit this array to change nav — components
 * derive from it.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    heading: null,
    items: [
      { label: "Overview", href: "/" },
      { label: "Explore", href: "/explore" },
    ],
  },
  {
    heading: "Collection",
    items: [
      { label: "Sources", href: "/sources" },
      { label: "Syncs", href: "/syncs" },
      { label: "Schedules", href: "/schedules" },
    ],
  },
  {
    heading: "Sharing",
    items: [
      { label: "Connect apps", href: "/connect" },
      { label: "Grants", href: "/grants" },
      { label: "Audit", href: "/audit" },
    ],
  },
  {
    heading: "Server",
    items: [
      { label: "Notifications", href: "/notifications" },
      { label: "Deployment", href: "/deployment" },
      { label: "Device exporters", href: "/device-exporters" },
      { label: "Event subscriptions", href: "/event-subscriptions" },
    ],
  },
  {
    heading: "Workspace",
    items: [{ label: "Settings", href: "/settings" }],
  },
];

/** Flat list of every nav item, for ⌘K palettes and tests. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

// ─── Active-route matching ────────────────────────────────────────
//
// `/connect` hosts two opposite data-flow directions under one URL prefix:
// `/connect` itself is outbound (granting an external client/agent read
// access), but five of its own sub-routes are inbound source-setup flows
// (their own breadcrumbs already say "Sources", not "Connect apps"). Plain
// prefix matching can't tell those apart, so these sub-routes are carved out
// to highlight "/sources" instead — the honest signal their breadcrumbs
// already carry. This is a minimal, in-place override; the correct fix is to
// physically move these routes under /sources (tracked separately as a
// judgment call, since it changes URLs).
const CONNECT_SOURCE_SETUP_PREFIXES = [
  "/connect/static-secret",
  "/connect/browser-session",
  "/connect/manual-upload",
  "/connect/provider-auth",
  "/connect/status",
];

function isConnectSourceSetupRoute(pathname: string): boolean {
  return CONNECT_SOURCE_SETUP_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// `/` (Overview) must match ONLY itself — every other route is a top-level
// noun off root, so an exact match is required for the root and a prefix match
// (segment-boundary aware) for the rest.
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  if (isConnectSourceSetupRoute(pathname)) {
    return href === "/sources";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
