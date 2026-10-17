// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useState, type ComponentType } from "react"
import { HashRouter, Link, Route, Routes, useLocation } from "react-router-dom"
import { Provider, useSelector } from "react-redux"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { PageContainer } from "@/components/elements/page-container"
import { PageHeading } from "@/components/typography/page-heading"
import { TopNav } from "@/components/navigation/top-nav"
import { dotPatternStyle } from "@/components/elements/dot-pattern"
import { ConnectorUpdatesRefreshButton } from "@/pages/home/components/connector-updates"
import type { RootState } from "@/state/store"
import { Home } from "@/pages/home"
import { DataApps } from "@/pages/data-apps"
import { Timeline } from "@/pages/timeline"
import { PersonalServer } from "@/pages/personal-server"
import { ServerRepairs } from "@/pages/server-repairs"
import { Docs } from "@/pages/docs"
import { SourceOverview } from "@/pages/source"
import { Settings } from "@/pages/settings"
import { Connect } from "@/pages/connect"
import { Grant } from "@/pages/grant"
import { store } from "@/state/store"
import {
  seedLegacyHarnessScenario,
  type LegacyHarnessScenario,
} from "./fixtures"
import { setLegacyHarnessScenario } from "./mock-tauri"

export interface LegacyHarnessRoute {
  path: string
  href: string
  label: string
  description: string
  group: string
  scenario: LegacyHarnessScenario
  Component: ComponentType
}

function InstallPanelRoute() {
  const connectorUpdates = useSelector(
    (state: RootState) => state.app.connectorUpdates
  )

  return (
    <PageContainer>
      <PageHeading>Connector install panel</PageHeading>
      <p className="mb-6 text-sm text-muted-foreground">
        Existing connector install and update surface, backed by fixture data.
      </p>
      <ConnectorUpdatesRefreshButton
        isCheckingUpdates={false}
        onRefresh={() => undefined}
      />
      <ul aria-label="Connector updates">
        {connectorUpdates.map(update => (
          <li key={update.id}>
            <span>{update.name}</span>{" "}
            <span>
              {update.isNew
                ? `Install ${update.latestVersion}`
                : update.hasUpdate
                  ? `Update ${update.currentVersion} → ${update.latestVersion}`
                  : `Current ${update.currentVersion ?? update.latestVersion}`}
            </span>
          </li>
        ))}
      </ul>
    </PageContainer>
  )
}

export const LEGACY_HARNESS_ROUTES: LegacyHarnessRoute[] = [
  {
    path: "/home/empty",
    href: "/home/empty?homeImportSourcesScenario=empty&connectedSourcesScenario=empty",
    label: "Home · empty",
    description: "No imported sources and an empty import grid.",
    group: "Home states",
    scenario: "home-empty",
    Component: Home,
  },
  {
    path: "/home/connected",
    href: "/home/connected?connectedSourcesScenario=mature",
    label: "Home · connected sources",
    description: "Connected GitHub, ChatGPT, and Spotify sources.",
    group: "Home states",
    scenario: "home-connected",
    Component: Home,
  },
  {
    path: "/home/running",
    href: "/home/running?homeImportSourcesScenario=background&connectedSourcesScenario=empty",
    label: "Home · import running",
    description: "A live import with progress and cancellation affordances.",
    group: "Home states",
    scenario: "home-running",
    Component: Home,
  },
  {
    path: "/home/error",
    href: "/home/error",
    label: "Home · error fixture",
    description: "A connected source with a terminal failed run in state.",
    group: "Home states",
    scenario: "home-error",
    Component: Home,
  },
  {
    path: "/home/credentials",
    href: "/home/credentials",
    label: "Home · credential prompts",
    description: "GitHub token and ChatGPT static-secret prompt triggers.",
    group: "Home states",
    scenario: "home-credentials",
    Component: Home,
  },
  {
    path: "/home/sources",
    href: "/home/sources",
    label: "Home · source tiers",
    description:
      "Available sources, connector-required rows, and coming-soon rows.",
    group: "Home states",
    scenario: "home-sources",
    Component: Home,
  },
  {
    path: "/install",
    href: "/install",
    label: "Connector install panel",
    description: "New connector and update actions from the existing panel.",
    group: "Native-backed surfaces",
    scenario: "install-panel",
    Component: InstallPanelRoute,
  },
  {
    path: "/settings/import-history",
    href: "/settings/import-history?section=imports&importsScenario=mixed",
    label: "Settings · import history",
    description: "Active, successful, partial, failed, and stopped imports.",
    group: "Settings states",
    scenario: "import-history",
    Component: Settings,
  },
  {
    path: "/settings/credentials",
    href: "/settings/credentials?section=credentials",
    label: "Settings · credentials",
    description: "Stored browser session rows and clear actions.",
    group: "Settings states",
    scenario: "settings-credentials",
    Component: Settings,
  },
  {
    path: "/settings",
    href: "/settings",
    label: "Settings",
    description: "The default settings page with app-access state.",
    group: "Legacy pages",
    scenario: "settings",
    Component: Settings,
  },
  {
    path: "/apps",
    href: "/apps",
    label: "Data Apps · discover",
    description: "The data-app registry page.",
    group: "Legacy pages",
    scenario: "data-apps",
    Component: DataApps,
  },
  {
    path: "/apps/connected",
    href: "/apps/connected?tab=connected&connectedAppsScenario=two-test-apps",
    label: "Data Apps · connected",
    description: "Connected-app state with fixture grants.",
    group: "Legacy pages",
    scenario: "data-apps",
    Component: DataApps,
  },
  {
    path: "/apps/timeline",
    href: "/apps/timeline",
    label: "Timeline",
    description: "Timeline page with the browser-safe unavailable state.",
    group: "Legacy pages",
    scenario: "timeline",
    Component: Timeline,
  },
  {
    path: "/personal-server",
    href: "/personal-server?personalServerScenario=ui-auth-running",
    label: "Personal Server",
    description: "Personal Server settings and running-state debug surface.",
    group: "Legacy pages",
    scenario: "personal-server",
    Component: PersonalServer,
  },
  {
    path: "/server-repairs",
    href: "/server-repairs",
    label: "Server & Repairs",
    description: "Reference-server lifecycle page in browser mode.",
    group: "Legacy pages",
    scenario: "server-repairs",
    Component: ServerRepairs,
  },
  {
    path: "/docs",
    href: "/docs",
    label: "Docs",
    description: "Legacy docs placeholder page.",
    group: "Legacy pages",
    scenario: "docs",
    Component: Docs,
  },
  {
    path: "/sources/github-pdpp",
    href: "/sources/github-pdpp",
    label: "Source · GitHub",
    description: "Source overview with fixture export preview.",
    group: "Legacy pages",
    scenario: "source",
    Component: SourceOverview,
  },
  {
    path: "/connect",
    href: "/connect?connectDebugState=collecting-data&appId=debug&scopes=%5B%22chatgpt.conversations%22%5D",
    label: "Connect",
    description: "Connect page with its collecting-data debug state.",
    group: "Grant pages",
    scenario: "connect",
    Component: Connect,
  },
  {
    path: "/grant",
    href: "/grant?grantStatus=consent&sessionId=grant-session-debug&appId=debug&scopes=%5B%22chatgpt.conversations%22%5D",
    label: "Grant",
    description: "Grant consent page with demo session fixtures.",
    group: "Grant pages",
    scenario: "grant",
    Component: Grant,
  },
]

function LegacyHarnessIndex() {
  const groups = [...new Set(LEGACY_HARNESS_ROUTES.map(route => route.group))]

  return (
    <PageContainer>
      <PageHeading>Legacy UI reference</PageHeading>
      <p className="mb-8 max-w-2xl text-sm text-muted-foreground">
        Browser-only render harness for the legacy React pages. Each link seeds
        the Redux store and routes native calls to fixture data.
      </p>
      <div className="space-y-8">
        {groups.map(group => (
          <section key={group} aria-labelledby={`legacy-group-${group}`}>
            <h2
              id={`legacy-group-${group}`}
              className="mb-3 text-sm font-medium"
            >
              {group}
            </h2>
            <ul className="space-y-2">
              {LEGACY_HARNESS_ROUTES.filter(route => route.group === group).map(
                route => (
                  <li key={route.path}>
                    <Link
                      to={route.href}
                      className="text-sm text-primary-700 underline-offset-4 hover:underline"
                    >
                      {route.label}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {route.description}
                    </p>
                  </li>
                )
              )}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-8 text-xs text-muted-foreground">
        Manual upload is not present in the legacy <code>src/pages</code> tree,
        so no route is fabricated for it.
      </p>
    </PageContainer>
  )
}

function HarnessPage({ route }: { route: LegacyHarnessRoute }) {
  useState(() => {
    setLegacyHarnessScenario(route.scenario)
    seedLegacyHarnessScenario(route.scenario)
  })

  const { Component } = route
  return <Component />
}

export function LegacyHarnessRoutes() {
  const location = useLocation()
  const locationKey = `${location.pathname}${location.search}`

  return (
    <>
      <TopNav />
      <main className="min-h-[calc(100vh-76px)]">
        <Routes>
          <Route path="/" element={<LegacyHarnessIndex />} />
          {LEGACY_HARNESS_ROUTES.map(route => (
            <Route
              key={route.path}
              path={route.path}
              element={<HarnessPage key={locationKey} route={route} />}
            />
          ))}
        </Routes>
      </main>
    </>
  )
}

export function LegacyHarnessApp() {
  return (
    <Provider store={store}>
      <TooltipProvider delayDuration={120}>
        <div style={dotPatternStyle} className="min-h-screen">
          <HashRouter>
            <LegacyHarnessRoutes />
          </HashRouter>
          <Toaster position="bottom-right" richColors />
        </div>
      </TooltipProvider>
    </Provider>
  )
}
