// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  clearAuth,
  setActiveRunIndex,
  setAppConfig,
  setAuthLoading,
  setConnectedApps,
  setConnectedPlatforms,
  setConnectorUpdates,
  setCurrentRoute,
  setIsMac,
  setIsRunLayerVisible,
  setPlatforms,
  setRuns,
  setAuthenticated,
  store,
} from "@/state/store"
import type {
  AppConfig,
  ConnectedApp,
  ConnectorUpdateInfo,
  Platform,
  Run,
} from "@/types"
import { testConnectedApps } from "@/pages/home/home-debug-fixtures"
import {
  TEST_ACTIVE_IMPORTS,
  TEST_FINISHED_IMPORTS,
} from "@/pages/settings/sections/imports/components/import-history-panel-state"
import type { BrowserSession } from "@/pages/settings/types"

export type LegacyHarnessScenario =
  | "home-empty"
  | "home-connected"
  | "home-running"
  | "home-error"
  | "home-credentials"
  | "home-sources"
  | "install-panel"
  | "import-history"
  | "settings-credentials"
  | "settings"
  | "connect"
  | "grant"
  | "timeline"
  | "source"
  | "personal-server"
  | "server-repairs"
  | "data-apps"
  | "docs"

export interface LegacyHarnessFixture {
  platforms: Platform[]
  runs: Run[]
  connectedPlatforms: Record<string, boolean>
  connectedApps: ConnectedApp[]
  connectorUpdates: ConnectorUpdateInfo[]
  browserSessions: BrowserSession[]
  appConfig: AppConfig
}

const staticSecretSetup: NonNullable<Platform["setup"]> = {
  modality: "static_secret",
  credentialCapture: {
    fields: [
      {
        name: "username",
        label: "ChatGPT email",
        type: "email",
        required: true,
        secret: true,
        autocomplete: "username",
      },
      {
        name: "password",
        label: "ChatGPT password",
        type: "password",
        required: true,
        secret: true,
        autocomplete: "current-password",
      },
    ],
  },
}

function platform({
  id,
  company,
  name,
  filename = id,
  description,
  runtime = "playwright",
  scopes,
  setup,
}: {
  id: string
  company: string
  name: string
  filename?: string
  description: string
  runtime?: string
  scopes?: string[]
  setup?: Platform["setup"]
}): Platform {
  return {
    id,
    company,
    name,
    filename,
    description,
    isUpdated: false,
    logoURL: "",
    needsConnection: true,
    connectURL:
      runtime === "playwright" ? `https://${filename}.example.test` : null,
    connectSelector: null,
    exportFrequency: null,
    vectorize_config: null,
    runtime,
    scopes,
    setup,
  }
}

const github = platform({
  id: "github-pdpp",
  company: "GitHub",
  name: "GitHub",
  description: "GitHub profile and repository data",
  runtime: "pdpp-network",
  scopes: ["github.profile", "github.repositories"],
})

const chatgpt = platform({
  id: "chatgpt-pdpp",
  company: "OpenAI",
  name: "ChatGPT",
  description: "ChatGPT conversations and memories",
  runtime: "pdpp-network",
  scopes: ["chatgpt.conversations", "chatgpt.memories"],
  setup: staticSecretSetup,
})

const chatgptLegacy = platform({
  id: "chatgpt",
  company: "OpenAI",
  name: "ChatGPT",
  filename: "chatgpt",
  description: "ChatGPT data export",
})

const spotify = platform({
  id: "spotify-playwright",
  company: "Spotify",
  name: "Spotify",
  description: "Spotify saved tracks and playlists",
})

const linkedin = platform({
  id: "linkedin-playwright",
  company: "LinkedIn",
  name: "LinkedIn",
  description: "LinkedIn profile data",
})

const platforms = [github, chatgpt, chatgptLegacy, spotify, linkedin]

function connectedPlatforms(...ids: string[]): Record<string, boolean> {
  const connected = Object.fromEntries(
    platforms.map(entry => [entry.id, false])
  )
  ids.forEach(id => {
    connected[id] = true
  })
  return connected
}

function run({
  id,
  platformId,
  status,
  statusMessage,
  exportPath,
  endDate,
  itemsExported,
  itemLabel,
}: {
  id: string
  platformId: string
  status: Run["status"]
  statusMessage?: string
  exportPath?: string
  endDate?: string
  itemsExported?: number
  itemLabel?: string
}): Run {
  const source = platforms.find(entry => entry.id === platformId) ?? chatgpt
  const startDate = new Date(Date.now() - 45 * 60_000).toISOString()
  return {
    id,
    platformId,
    filename: source.filename,
    runtime: source.runtime,
    isConnected: status !== "error",
    startDate,
    endDate,
    status,
    url: source.connectURL ?? "",
    company: source.company,
    name: source.name,
    statusMessage,
    exportPath,
    itemsExported,
    itemLabel,
    logs: status === "error" ? "The fixture connector returned an error." : "",
    phase:
      status === "running"
        ? { step: 2, total: 4, label: "Collecting conversations" }
        : undefined,
    itemCount: status === "running" ? 128 : undefined,
  }
}

const completedAt = new Date(Date.now() - 20 * 60_000).toISOString()

const connectorUpdates: ConnectorUpdateInfo[] = [
  {
    id: "github-pdpp",
    tier: "supported",
    requiredBindings: [],
    setupModality: "static_secret",
    runnable: true,
    unavailableReason: null,
    name: "GitHub",
    description: "GitHub collection profile",
    company: "GitHub",
    currentVersion: null,
    latestVersion: "0.4.0",
    hasUpdate: false,
    isNew: true,
  },
  {
    id: "chatgpt-playwright",
    tier: "supported",
    requiredBindings: ["browser_session"],
    setupModality: "browser_session",
    runnable: true,
    unavailableReason: null,
    name: "ChatGPT",
    description: "ChatGPT browser connector",
    company: "OpenAI",
    currentVersion: "1.1.0",
    latestVersion: "1.2.0",
    hasUpdate: true,
    isNew: false,
  },
]

const browserSessions: BrowserSession[] = [
  {
    connectorId: "chatgpt-playwright",
    path: "/Users/demo/.dataconnect/sessions/chatgpt",
    sizeBytes: 42_800,
    lastModified: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  },
  {
    connectorId: "github-playwright",
    path: "/Users/demo/.dataconnect/sessions/github",
    sizeBytes: 18_400,
    lastModified: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  },
]

const appConfig: AppConfig = {
  storageProvider: "local",
  serverMode: "local-only",
}

const baseFixture: LegacyHarnessFixture = {
  platforms,
  runs: [],
  connectedPlatforms: connectedPlatforms(),
  connectedApps: testConnectedApps,
  connectorUpdates,
  browserSessions,
  appConfig,
}

export function getLegacyHarnessFixture(
  scenario: LegacyHarnessScenario
): LegacyHarnessFixture {
  switch (scenario) {
    case "home-empty":
    case "home-sources":
      return {
        ...baseFixture,
        runs: [],
        connectedPlatforms: connectedPlatforms(),
      }
    case "home-connected":
      return {
        ...baseFixture,
        connectedPlatforms: connectedPlatforms(
          "github-pdpp",
          "chatgpt-pdpp",
          "spotify-playwright"
        ),
        runs: [
          run({
            id: "fixture-github-success",
            platformId: "github-pdpp",
            status: "success",
            exportPath: "/Users/demo/DataConnect/github/export.json",
            endDate: completedAt,
            itemsExported: 86,
            itemLabel: "records",
          }),
          run({
            id: "fixture-chatgpt-success",
            platformId: "chatgpt-pdpp",
            status: "success",
            exportPath: "/Users/demo/DataConnect/chatgpt/export.json",
            endDate: completedAt,
            itemsExported: 214,
            itemLabel: "conversations",
          }),
        ],
      }
    case "home-running":
      return {
        ...baseFixture,
        runs: [
          run({
            id: "fixture-chatgpt-running",
            platformId: "chatgpt-pdpp",
            status: "running",
            statusMessage: "Collecting data...",
          }),
        ],
      }
    case "home-error":
      return {
        ...baseFixture,
        connectedPlatforms: connectedPlatforms("github-pdpp"),
        runs: [
          run({
            id: "fixture-github-error",
            platformId: "github-pdpp",
            status: "error",
            statusMessage: "Import failed: authorization expired.",
          }),
        ],
      }
    case "home-credentials":
      return {
        ...baseFixture,
        runs: [],
        connectedPlatforms: connectedPlatforms(),
      }
    case "install-panel":
      return { ...baseFixture, connectorUpdates }
    case "import-history":
      return {
        ...baseFixture,
        platforms: [chatgpt, chatgptLegacy, github, spotify, linkedin],
        runs: [...TEST_ACTIVE_IMPORTS, ...TEST_FINISHED_IMPORTS],
      }
    case "settings-credentials":
    case "settings":
    case "connect":
    case "grant":
    case "timeline":
    case "source":
    case "personal-server":
    case "server-repairs":
    case "data-apps":
    case "docs":
      return baseFixture
  }
}

export function seedLegacyHarnessScenario(scenario: LegacyHarnessScenario) {
  const fixture = getLegacyHarnessFixture(scenario)

  store.dispatch(clearAuth())
  store.dispatch(setAuthLoading(false))
  store.dispatch(
    setAuthenticated({
      user: { id: "legacy-harness-owner", email: "owner@example.test" },
      walletAddress: "0x0000000000000000000000000000000000000001",
      masterKeySignature: "fixture-master-key-signature",
    })
  )
  store.dispatch(setCurrentRoute("/"))
  store.dispatch(setActiveRunIndex(0))
  store.dispatch(setIsRunLayerVisible(false))
  store.dispatch(setIsMac(false))
  store.dispatch(setPlatforms(fixture.platforms))
  store.dispatch(setRuns(fixture.runs))
  store.dispatch(setConnectedPlatforms(fixture.connectedPlatforms))
  store.dispatch(setConnectedApps(fixture.connectedApps))
  store.dispatch(setConnectorUpdates(fixture.connectorUpdates))
  store.dispatch(setAppConfig(fixture.appConfig))
}
