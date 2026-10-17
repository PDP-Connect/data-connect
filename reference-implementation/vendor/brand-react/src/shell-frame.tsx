// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RecordroomShell — the Ink Carbon owner-console frame.
 *
 * (Component/CSS identifiers keep the internal `Recordroom`/`rr-*` names; the
 * owner-visible product identity is DataConnect.)
 *
 * The dependency root of the redesigned console: a left sidebar (brand mark +
 * grouped nav + footer host block) and a main column with a sticky header
 * (⌘K jump affordance, theme toggle, mobile menu) wrapping `{children}`. The
 * `{host} · {build}` crumb lives in the sidebar/drawer footer only — not the
 * header — so it renders exactly once. On narrow screens the sidebar folds into
 * a drawer overlay.
 *
 * Ported from `rr-app.jsx` (the design SHELL) and rebound to the REAL app:
 *
 * NAV RECONCILIATION (design groups vs real routes):
 *   The shell uses owner-facing labels for the real routes the dashboard
 *   enforces (those routes are pinned by next.config.mjs redirects + tests).
 *   The labels answer the owner's core questions:
 *     - "Overview" -> where the instance stands and what needs attention.
 *     - "Explore" -> the reader for records already in this instance.
 *     - "Sources" -> configured data sources and their streams.
 *     - "Syncs" -> the clean Syncs route `/syncs`, using the warmer
 *       owner-facing label from the page title. See SYNCS_NOTE below.
 *     - "Schedules" -> the real schedule management route.
 *     - "Notifications" -> device-level owner-action alert setup.
 *     - "Connect apps" -> reader/client access, grouped with sharing, not
 *       source collection.
 *   `NAV_GROUPS` is a typed array so leaf views / future edits are trivial.
 *
 * THEME: the toggle flips BOTH `data-theme` and the `dark` class on <html> so
 * the Ink Carbon tokens (light `:root`, dark `[data-theme="dark"]`) and
 * the existing Tailwind/shadcn `dark:` variants react together.
 *
 * OWNER IDENTITY: there is none to show — owner auth is invisible (cookie-gated).
 * The footer is a host line + build crumb, NOT a user menu.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import "./components.css";
import {
  IcDialog,
  IcDialogBackdrop,
  IcDialogClose,
  IcDialogPopup,
  IcDialogPortal,
  IcDialogTrigger,
} from "./dialog.tsx";
import { DATACONNECT_PRODUCT_IDENTITY } from "./product-identity.ts";
import "./shell.css";

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

// ─── DataConnect mark ───────────────────────────────────────────
//
// It is inlined here rather than imported so `@pdpp/brand-react` stays a leaf
// brand package with no dependency on `@pdpp/operator-ui` (the console → shared
// dependency direction is one-way). This keeps the package-boundary contract
// intact while still shipping the real logo, not a placeholder shape.
function BrandMark() {
  return (
    <svg aria-hidden="true" className="rr-side__mark" height="18" role="presentation" viewBox="0 0 832 832" width="18">
      <rect fill="url(#rr-dataconnect-mark-bg)" height="832" rx="183" width="832" />
      <path
        d="M188.955 197.596C309.404 197.596 407.047 295.552 407.047 416C407.047 536.449 309.404 634.405 188.955 634.405C187.051 634.405 185.153 634.38 183.262 634.332C161.511 633.772 150.635 633.492 140.716 623.315C130.797 613.137 130.797 599.88 130.797 573.367V258.633C130.797 232.12 130.797 218.864 140.716 208.686C150.636 198.508 161.511 198.229 183.262 197.669C185.154 197.621 187.051 197.596 188.955 197.596Z"
        fill="white"
      />
      <path
        d="M657.638 634.404C537.19 634.404 439.547 536.449 439.547 416.001C439.547 295.552 537.19 197.596 657.638 197.596C659.542 197.596 661.44 197.621 663.332 197.669C685.082 198.229 695.958 198.509 705.877 208.686C715.797 218.864 715.797 232.121 715.797 258.634L715.797 573.368C715.797 599.88 715.797 613.136 705.877 623.314C695.957 633.492 685.082 633.772 663.331 634.331C661.44 634.379 659.542 634.404 657.638 634.404Z"
        fill="white"
      />
      <defs>
        <linearGradient id="rr-dataconnect-mark-bg" x1="416" x2="416" y1="0" y2="832" gradientUnits="userSpaceOnUse">
          <stop offset="0.100024" stopColor="#304DC0" />
          <stop offset="0.578171" stopColor="#121265" />
          <stop offset="0.956731" stopColor="#090939" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// ─── Nav list (shared by sidebar + drawer) ────────────────────────

function NavList({ pathname, onNavigate }: { onNavigate?: () => void; pathname: string }) {
  return (
    <>
      {NAV_GROUPS.map((group) => (
        <div className="rr-nav-group" key={group.heading ?? "_top"}>
          {group.heading && <div className="rr-side__group">{group.heading}</div>}
          {group.items.map((item) => {
            const active = isNavItemActive(item.href, pathname);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={["rr-nav-item", active ? "is-active" : undefined].filter(Boolean).join(" ")}
                href={item.href}
                key={item.href}
                // next/link's own LinkProps.onClick is `MouseEventHandler | undefined`
                // WITHOUT the explicit `| undefined` in its declared type, so passing
                // `onNavigate` (`(() => void) | undefined`) directly fails under
                // exactOptionalPropertyTypes -- the third-party type genuinely means
                // "key absent or a real handler", not "key present holding undefined".
                // Omit the key entirely when there's no handler.
                {...(onNavigate ? { onClick: onNavigate } : {})}
              >
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}

// ─── Footer host block ────────────────────────────────────────────

function FootBlock({ host, build }: { build: string; host: string }) {
  // Theme toggle lives here in the sidebar footer — a quiet utility, not a
  // front-and-center header action. The hook flips <html> so any toggle
  // instance stays in sync via the DOM.
  const [theme, toggleTheme] = useThemeToggle();
  const themeLabel = theme === "dark" ? "Dark" : "Light";
  const themeTitle = theme === "dark" ? "Switch to light" : "Switch to dark";
  return (
    <div className="rr-side__foot">
      <span className="rr-side__host">
        {host} · {build}
      </span>
      <span className="rr-side__motto">your data, at home</span>
      <button className="rr-side__theme rr-chrome-btn" onClick={toggleTheme} title={themeTitle} type="button">
        {themeLabel}
      </button>
    </div>
  );
}

// ─── Theme toggle (flips <html> data-theme + dark class) ──────────

type Theme = "dark" | "light";

function readInitialTheme(): Theme {
  if (typeof document === "undefined") {
    return "dark";
  }
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light") {
    return "light";
  }
  if (attr === "dark") {
    return "dark";
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.classList.toggle("dark", theme === "dark");
}

function useThemeToggle(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("dark");

  // Sync from the SSR-rendered <html> on mount (avoids a hydration flip).
  useEffect(() => {
    setTheme(readInitialTheme());
  }, []);

  const toggle = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);

  return [theme, toggle];
}

// ─── RecordroomShell ──────────────────────────────────────────────

interface RecordroomShellProps {
  /** Optional build override for development or a downstream distribution. */
  build?: string;
  children: ReactNode;
  /** Host line for the header crumb + sidebar foot, e.g. "rs.owner.example.net". */
  host?: string;
  /** Called when the ⌘K jump affordance is activated (open a command palette). */
  onJump?: () => void;
}

export function RecordroomShell({
  children,
  host = "this server",
  onJump,
  build,
}: RecordroomShellProps) {
  const identity = DATACONNECT_PRODUCT_IDENTITY;
  const resolvedBuild = build ?? `${identity.name} ${identity.version}`;
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <IcDialog modal onOpenChange={setDrawerOpen} open={drawerOpen}>
      <div className="rr-app">
        {/* ─── Desktop sidebar ─── */}
        <aside className="rr-side">
          <div className="rr-side__brand">
            <BrandMark />
            <span className="rr-side__name">{identity.name}</span>
          </div>
          <nav aria-label="Primary" className="rr-side__nav">
            <NavList pathname={pathname} />
          </nav>
          <div className="rr-side__spacer" />
          <FootBlock build={resolvedBuild} host={host} />
        </aside>

        {/* ─── Main column ─── */}
        <main className="rr-main">
          <header className="rr-head">
            <span className="rr-head__brand">
              <BrandMark />
              <span>{identity.name}</span>
            </span>
            {/* The `{host} · {build}` crumb renders in exactly ONE owner-facing
              place: the sidebar/drawer FootBlock. It used to also render here in
              the header, so the owner saw it twice (top and bottom). Keeping it
              only in the nav footer removes the duplication. */}
            <div className="rr-head__actions">
              {/* Jump (⌘K) renders ONLY when a caller wires onJump — no dead
                affordance. The ⌘K shortcut itself is owned by the palette
                provider, not this shell. Pages that mount a command palette
                pass onJump so the button and the shortcut open the same one. */}
              {onJump ? (
                <button className="rr-chrome-btn" onClick={onJump} type="button">
                  Jump <span className="rr-kbd">⌘K</span>
                </button>
              ) : null}
              <IcDialogTrigger className="rr-chrome-btn rr-menu-btn" type="button">
                Menu
              </IcDialogTrigger>
            </div>
          </header>
          <div className="rr-content">{children}</div>
        </main>

        {/* ─── Mobile drawer ─── */}
        <IcDialogPortal>
          <IcDialogBackdrop className="rr-drawer-overlay" />
          <IcDialogPopup aria-label="Primary navigation" className="rr-drawer">
            <nav aria-label="Primary">
              <div className="rr-side__brand">
                <BrandMark />
                <span className="rr-side__name">{identity.name}</span>
                <IcDialogClose aria-label="Close navigation" className="rr-drawer__close rr-chrome-btn" type="button">
                  Close
                </IcDialogClose>
              </div>
              <div className="rr-drawer__nav">
                <NavList onNavigate={closeDrawer} pathname={pathname} />
              </div>
              <FootBlock build={resolvedBuild} host={host} />
            </nav>
          </IcDialogPopup>
        </IcDialogPortal>
      </div>
    </IcDialog>
  );
}
