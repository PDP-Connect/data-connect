// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RecordroomShell — the Ink Carbon owner-console frame.
 *
 * (Component/CSS identifiers keep the internal `Recordroom`/`rr-*` names; the
 * owner-visible product identity is DataConnect.)
 *
 * The dependency root of the redesigned console: a left menu with search,
 * grouped destinations and a version/theme footer, plus the page content.
 * On narrow screens the menu opens in the existing drawer below a 52px bar.
 *
 * Ported from `rr-app.jsx` (the design SHELL) and rebound to the REAL app:
 *
 * NAV_GROUPS keeps every destination in one place. Section children are shown
 * only while the pathname belongs to their parent section. The Apps destination
 * opens `/grants`; `/connect` remains its child.
 *
 * THEME: the toggle flips BOTH `data-theme` and the `dark` class on <html> so
 * the Ink Carbon tokens (light `:root`, dark `[data-theme="dark"]`) and
 * the existing Tailwind/shadcn `dark:` variants react together.
 *
 * OWNER IDENTITY: there is none to show — owner auth is invisible (cookie-gated).
 * The footer contains the app version and a theme control, not a user menu.
 */
"use client";

import { AppWindow, Compass, Database, Home, type LucideIcon, Menu, Settings2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import "./components.css";
import {
  IcDialog,
  IcDialogBackdrop,
  IcDialogClose,
  IcDialogPopup,
  IcDialogPortal,
  IcDialogTrigger,
} from "./dialog.tsx";
import { DEFAULT_JUMP_SHORTCUT_LABEL, jumpShortcutLabel } from "./jump-shortcut.ts";
import { DATACONNECT_PRODUCT_IDENTITY } from "./product-identity.ts";
import { ShellThemeButton } from "./shell-theme.tsx";
import "./shell.css";
import { bindDrawerDrag } from "./drawer-drag.ts";

export interface NavItem {
  /** Real route href (pinned by redirects/tests). */
  href: string;
  /** Display label (design vocabulary where it maps). */
  label: string;
  icon?: LucideIcon;
  section?: NavSection;
  children?: NavItem[];
  labelBefore?: string;
}

export type NavSection = "data-sources" | "apps" | "settings";

export interface NavGroup {
  /** Group heading; null for the ungrouped orientation items. */
  heading: string | null;
  items: NavItem[];
}

/**
 * Edit this array to change the menu. The flat list and rendered links derive
 * from it.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    heading: null,
    items: [
      { label: "Home", href: "/", icon: Home },
      {
        label: "Data sources",
        href: "/sources",
        icon: Database,
        section: "data-sources",
        children: [
          { label: "Sync history", href: "/syncs" },
          { label: "Schedules", href: "/schedules" },
        ],
      },
      { label: "Explore", href: "/explore", icon: Compass },
      {
        label: "Apps",
        href: "/grants",
        icon: AppWindow,
        section: "apps",
        children: [
          { label: "Connect an app", href: "/connect" },
          { label: "Activity", href: "/audit" },
        ],
      },
      {
        label: "Settings",
        href: "/settings",
        icon: Settings2,
        section: "settings",
        children: [
          { label: "Notifications", href: "/notifications" },
          { label: "Server", href: "/deployment", labelBefore: "Advanced" },
          { label: "Collectors on your devices", href: "/device-exporters", labelBefore: "Advanced" },
          { label: "Webhooks", href: "/event-subscriptions", labelBefore: "Advanced" },
        ],
      },
    ],
  },
];

function flattenNavItems(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flattenNavItems(item.children ?? [])]);
}

/** Flat list of every menu item, including section children. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => flattenNavItems(group.items));

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

// `/` (Home) must match ONLY itself — every other route is a top-level
// noun off root, so an exact match is required for the root and a prefix match
// (segment-boundary aware) for the rest.
export function isNavItemActive(href: string, pathname: string): boolean {
  if (pathname.startsWith("/deployment/tokens")) {
    if (href === "/deployment") return false;
    if (href === "/settings") return true;
  }
  if (href === "/") {
    return pathname === "/";
  }
  if (isConnectSourceSetupRoute(pathname)) {
    return href === "/sources";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Returns the one menu section that owns a route, including nested routes. */
export function navSectionForPathname(pathname: string): NavSection | null {
  const path = (pathname.split(/[?#]/, 1)[0] ?? "").replace(/\/+$/, "") || "/";
  if (
    path === "/sources" ||
    path.startsWith("/sources/") ||
    path === "/syncs" ||
    path.startsWith("/syncs/") ||
    path === "/schedules" ||
    path.startsWith("/schedules/") ||
    isConnectSourceSetupRoute(path)
  ) {
    return "data-sources";
  }
  if (path === "/connect" || path === "/connect/technical") {
    return "apps";
  }
  if (
    path === "/grants" ||
    path.startsWith("/grants/") ||
    path === "/audit" ||
    path.startsWith("/audit/")
  ) {
    return "apps";
  }
  if (
    path === "/settings" ||
    path.startsWith("/settings/") ||
    path === "/notifications" ||
    path.startsWith("/notifications/") ||
    path === "/deployment" ||
    path.startsWith("/deployment/") ||
    path === "/device-exporters" ||
    path.startsWith("/device-exporters/") ||
    path === "/event-subscriptions" ||
    path.startsWith("/event-subscriptions/")
  ) {
    return "settings";
  }
  return null;
}

// ─── DataConnect mark ───────────────────────────────────────────
//
// It is inlined here rather than imported so `@pdpp/brand-react` stays a leaf
// brand package with no dependency on `@pdpp/operator-ui` (the console → shared
// dependency direction is one-way). This keeps the package-boundary contract
// intact while still shipping the real logo, not a placeholder shape.
function BrandMark() {
  return (
    <svg aria-hidden="true" className="rr-side__mark" height="16" role="presentation" viewBox="120 190 606 452" width="22">
      <path
        d="M188.955 197.596C309.404 197.596 407.047 295.552 407.047 416C407.047 536.449 309.404 634.405 188.955 634.405C187.051 634.405 185.153 634.38 183.262 634.332C161.511 633.772 150.635 633.492 140.716 623.315C130.797 613.137 130.797 599.88 130.797 573.367V258.633C130.797 232.12 130.797 218.864 140.716 208.686C150.636 198.508 161.511 198.229 183.262 197.669C185.154 197.621 187.051 197.596 188.955 197.596Z"
        fill="currentColor"
      />
      <path
        d="M657.638 634.404C537.19 634.404 439.547 536.449 439.547 416.001C439.547 295.552 537.19 197.596 657.638 197.596C659.542 197.596 661.44 197.621 663.332 197.669C685.082 198.229 695.958 198.509 705.877 208.686C715.797 218.864 715.797 232.121 715.797 258.634L715.797 573.368C715.797 599.88 715.797 613.136 705.877 623.314C695.957 633.492 685.082 633.772 663.331 634.331C661.44 634.379 659.542 634.404 657.638 634.404Z"
        fill="currentColor"
      />
    </svg>
  );
}

// ─── Nav list (shared by sidebar + drawer) ────────────────────────

function NavList({ pathname, onNavigate }: { onNavigate?: () => void; pathname: string }) {
  const section = navSectionForPathname(pathname);
  const renderItem = (item: NavItem, nested = false, previousSibling?: NavItem) => {
    const active = isNavItemActive(item.href, pathname);
    const Icon = item.icon;
    return (
      <div className={nested ? "rr-nav-child" : undefined} key={item.href}>
        {"labelBefore" in item && item.labelBefore && item.labelBefore !== previousSibling?.labelBefore ? (
          <h3 className="rr-side__group rr-side__group--nested font-semibold uppercase tracking-wide">{item.labelBefore}</h3>
        ) : null}
        <Link
          aria-current={active ? "page" : undefined}
          className={["rr-nav-item", nested ? "rr-nav-item--child" : undefined, active ? "is-active" : undefined].filter(Boolean).join(" ")}
          href={item.href}
          {...(onNavigate ? { onClick: onNavigate } : {})}
        >
          {Icon ? <Icon aria-hidden="true" className="rr-nav-item__icon" size={16} strokeWidth={1.7} /> : null}
          <span>{item.label}</span>
        </Link>
        {!nested && item.children && item.section === section ? (
          <div className="rr-nav-children">
            {item.children.map((child, index) => renderItem(child, true, item.children?.[index - 1]))}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <>
      {NAV_GROUPS.map((group) => (
        <div className="rr-nav-group" key={group.heading ?? "_top"}>
          {group.heading && <div className="rr-side__group">{group.heading}</div>}
          {group.items.map((item) => renderItem(item))}
        </div>
      ))}
    </>
  );
}

// ─── Footer block ─────────────────────────────────────────────────

function FootBlock({ version }: { version: string }) {
  // Use the same theme control in the sidebar and the portaled drawer.
  return (
    <div className="rr-side__foot">
      <span className="rr-side__version">{version}</span>
      <ShellThemeButton />
    </div>
  );
}


// ─── Jump button (platform-aware shortcut label) ──────────────────

function detectPlatform(): string | undefined {
  if (typeof navigator === "undefined") {
    return;
  }
  const withUaData = navigator as Navigator & { userAgentData?: { platform?: string } };
  return withUaData.userAgentData?.platform || navigator.platform;
}

const subscribeNever = () => () => undefined;
const clientJumpLabel = () => jumpShortcutLabel(detectPlatform());
const serverJumpLabel = () => DEFAULT_JUMP_SHORTCUT_LABEL;

function JumpButton({ onJump, onClose }: { onJump: () => void; onClose?: () => void }) {
  // The server snapshot is the neutral label, so hydration matches the server
  // markup; the client snapshot switches to the Command glyph on Apple platforms.
  const label = useSyncExternalStore(subscribeNever, clientJumpLabel, serverJumpLabel);
  return (
    <button
      aria-keyshortcuts="Control+K"
      aria-label="Search or jump to commands"
      className="rr-search-button"
      onClick={() => {
        onClose?.();
        onJump();
      }}
      type="button"
    >
      <span>Search or jump to…</span>
      <span className="rr-kbd">{label}</span>
    </button>
  );
}

// ─── RecordroomShell ──────────────────────────────────────────────

interface RecordroomShellProps {
  /** Optional build override for development or a downstream distribution. */
  build?: string;
  children: ReactNode;
  /** Called when the search or jump affordance is activated (open the command palette). */
  onJump?: () => void;
}

export function RecordroomShell({ children, onJump, build }: RecordroomShellProps) {
  const identity = DATACONNECT_PRODUCT_IDENTITY;
  const resolvedVersion = build ?? `${identity.name} ${identity.version}`;
  const pathname = usePathname() ?? "";
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const previewRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(drawerOpen);
  useLayoutEffect(() => {
    openRef.current = drawerOpen;
  }, [drawerOpen]);
  useEffect(() => {
    const template = previewRef.current;
    if (!template) {
      return;
    }
    return bindDrawerDrag(template, () => openRef.current, setDrawerOpen);
  }, []);

  const drawerContents = (
    <nav aria-label="Primary">
      <div className="rr-side__brand">
        <BrandMark />
        <span className="rr-side__name">{identity.name}</span>
        <IcDialogClose aria-label="Close navigation" className="rr-drawer__close rr-chrome-btn" type="button">
          Close
        </IcDialogClose>
      </div>
      {onJump ? <JumpButton onClose={closeDrawer} onJump={onJump} /> : null}
      <div className="rr-drawer__nav">
        <NavList onNavigate={closeDrawer} pathname={pathname} />
      </div>
      <FootBlock version={resolvedVersion} />
    </nav>
  );

  return (
    <IcDialog modal onOpenChange={setDrawerOpen} open={drawerOpen}>
      <div className="rr-app">
        {/* ─── Desktop sidebar ─── */}
        <aside className="rr-side">
          <div className="rr-side__brand">
            <Link className="rr-side__brand-link" href="/">
              <BrandMark />
              <span className="rr-side__name">{identity.name}</span>
            </Link>
          </div>
          {onJump ? <JumpButton onJump={onJump} /> : null}
          <nav aria-label="Primary" className="rr-side__nav">
            <NavList pathname={pathname} />
          </nav>
          <div className="rr-side__spacer" />
          <FootBlock version={resolvedVersion} />
        </aside>

        {/* ─── Main column ─── */}
        <main className="rr-main">
          <header className="rr-head">
            <Link className="rr-head__brand" href="/">
              <BrandMark />
              <span>{identity.name}</span>
            </Link>
            <div className="rr-head__actions">
              <IcDialogTrigger aria-label="Open navigation" className="rr-chrome-btn rr-menu-btn" type="button">
                <Menu aria-hidden="true" size={18} strokeWidth={1.8} />
              </IcDialogTrigger>
            </div>
          </header>
          <div className="rr-content">{children}</div>
        </main>

        {/* An inert visual template: the real dialog opens only after release. */}
        <div aria-hidden="true" className="pdpp-dialog rr-drawer" hidden inert ref={previewRef}>
          {drawerContents}
        </div>
        {/* ─── Mobile drawer ─── */}
        <IcDialogPortal>
          <IcDialogBackdrop className="rr-drawer-overlay" />
          <IcDialogPopup aria-label="Primary navigation" className="rr-drawer">
            {drawerContents}
          </IcDialogPopup>
        </IcDialogPortal>
      </div>
    </IcDialog>
  );
}
