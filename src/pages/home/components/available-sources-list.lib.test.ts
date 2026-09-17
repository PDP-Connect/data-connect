// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest"
import type { ConnectorUpdateInfo, Platform, Run } from "@/types"
import { buildAvailableCards } from "./available-sources-list.lib"

vi.mock("@/lib/platform/utils", () => ({
  getPlatformRegistryEntry: (platform: { id?: string }) => {
    const entries: Record<
      string,
      {
        id?: string
        displayName: string
        availability?: string
        brandDomain?: string
        platformIds?: string[]
      }
    > = {
      chatgpt: {
        displayName: "ChatGPT",
        availability: "requiresConnector",
        brandDomain: "chatgpt.com",
      },
      "coming-soon-platform": {
        displayName: "Coming Soon Platform",
        availability: "comingSoon",
        brandDomain: "example.com",
      },
      spotify: {
        displayName: "Spotify",
        availability: "available",
        brandDomain: "spotify.com",
      },
      x: {
        id: "x",
        displayName: "X (Twitter)",
        availability: "comingSoon",
        brandDomain: "x.com",
        platformIds: ["x", "twitter"],
      },
      reddit: {
        id: "reddit",
        displayName: "Reddit",
        availability: "comingSoon",
        brandDomain: "reddit.com",
        platformIds: ["reddit"],
      },
      "reddit-pdpp": {
        id: "reddit",
        displayName: "Reddit",
        availability: "comingSoon",
        brandDomain: "reddit.com",
        platformIds: ["reddit"],
      },
      twitter: {
        id: "x",
        displayName: "X (Twitter)",
        availability: "comingSoon",
        brandDomain: "x.com",
        platformIds: ["x", "twitter"],
      },
      heb: {
        displayName: "H-E-B",
        availability: "requiresConnector",
        brandDomain: "heb.com",
        platformIds: ["heb-playwright", "heb"],
      },
      "heb-playwright": {
        id: "heb",
        displayName: "H-E-B",
        availability: "requiresConnector",
        brandDomain: "heb.com",
        platformIds: ["heb-playwright", "heb"],
      },
      "heb-pdpp": {
        id: "heb",
        displayName: "H-E-B",
        availability: "requiresConnector",
        brandDomain: "heb.com",
        platformIds: ["heb-pdpp", "heb-playwright"],
      },
      "github-pdpp": {
        id: "github",
        displayName: "GitHub",
        availability: "requiresConnector",
        brandDomain: "github.com",
        platformIds: ["github-pdpp", "github-playwright"],
      },
      "github-playwright": {
        id: "github",
        displayName: "GitHub",
        availability: "requiresConnector",
        brandDomain: "github.com",
        platformIds: ["github-pdpp", "github-playwright"],
      },
    }
    return platform.id ? (entries[platform.id] ?? null) : null
  },
}))

vi.mock("@/lib/platform/resolve-platform-logo", () => ({
  resolvePlatformLogo: () => undefined,
}))

vi.mock("@/lib/platform/logo-provider", () => ({
  getPlatformLogoUrlForDomain: (domain: string) =>
    `https://img.logo.dev/${domain}?mock`,
}))

vi.mock("@/lib/platform/registry", () => ({
  PLATFORM_REGISTRY: [
    {
      id: "x",
      displayName: "X (Twitter)",
      brandDomain: "x.com",
      platformIds: ["x", "twitter"],
      availability: "comingSoon",
    },
    {
      id: "reddit",
      displayName: "Reddit",
      brandDomain: "reddit.com",
      platformIds: ["reddit"],
      availability: "comingSoon",
    },
    {
      id: "test-coming-soon",
      displayName: "Test Coming Soon",
      brandDomain: "test-coming-soon.com",
      platformIds: ["test-coming-soon"],
      availability: "comingSoon",
    },
  ],
}))

function makePlatform(id: string, overrides: Partial<Platform> = {}): Platform {
  return {
    id,
    company: id,
    name: id,
    filename: id,
    description: `${id} connector`,
    isUpdated: false,
    logoURL: "",
    needsConnection: true,
    connectURL: null,
    connectSelector: null,
    exportFrequency: null,
    vectorize_config: null,
    runtime: null,
    ...overrides,
  }
}

function makeUpdate(
  id: string,
  overrides: Partial<ConnectorUpdateInfo> = {}
): ConnectorUpdateInfo {
  return {
    id,
    name: id,
    description: `${id} connector`,
    company: id,
    currentVersion: null,
    latestVersion: "1.0.0",
    hasUpdate: false,
    isNew: true,
    tier: "supported",
    requiredBindings: [],
    setupModality: null,
    runnable: true,
    unavailableReason: null,
    ...overrides,
  }
}

describe("buildAvailableCards — availability", () => {
  const onExport = vi.fn()
  const emptyConnected = new Set<string>()
  const emptyConnecting = new Map()

  it('sets availability to "requiresConnector" for platforms with that registry entry', () => {
    const cards = buildAvailableCards({
      platforms: [makePlatform("chatgpt")],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    })

    const card = cards.find(c => c.cardId === "chatgpt")
    expect(card).toBeDefined()
    expect(card?.availability).toBe("requiresConnector")
    expect(card?.isAvailable).toBe(true)
  })

  it('sets availability to "comingSoon" and disables the card', () => {
    const cards = buildAvailableCards({
      platforms: [makePlatform("coming-soon-platform")],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    })

    const card = cards.find(c => c.cardId === "coming-soon-platform")
    expect(card).toBeDefined()
    expect(card?.availability).toBe("comingSoon")
    expect(card?.isAvailable).toBe(false)
    expect(card?.onClick).toBeUndefined()
  })

  it('sets availability to "available" and enables the card', () => {
    const cards = buildAvailableCards({
      platforms: [makePlatform("spotify")],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    })

    const card = cards.find(c => c.cardId === "spotify")
    expect(card).toBeDefined()
    expect(card?.availability).toBe("available")
    expect(card?.isAvailable).toBe(true)
    expect(card?.onClick).toBeDefined()
  })

  it("lets a runnable catalog connector override a static coming-soon flag", () => {
    const cards = buildAvailableCards({
      platforms: [],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
      connectorUpdates: [makeUpdate("reddit-pdpp", { name: "Reddit" })],
      onInstall: vi.fn(),
    })

    const reddit = cards.find(card => card.sourceKey === "reddit")
    const x = cards.find(card => card.sourceKey === "x")
    expect(reddit?.action).toBe("install")
    expect(reddit?.availability).toBe("available")
    expect(reddit?.isAvailable).toBe(true)
    expect(reddit?.label).toBe("Add Reddit")
    expect(x?.action).toBe("comingSoon")
    expect(cards.indexOf(reddit!)).toBeLessThan(cards.indexOf(x!))
  })

  it('sets availability to "unknown" for platforms without a registry entry', () => {
    const cards = buildAvailableCards({
      platforms: [makePlatform("unregistered-platform")],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    })

    const card = cards.find(c => c.cardId === "unregistered-platform")
    expect(card).toBeDefined()
    expect(card?.availability).toBe("unknown")
    expect(card?.isAvailable).toBe(true)
  })

  it("preserves sort order: runtime platforms before injected registry entries", () => {
    const cards = buildAvailableCards({
      platforms: [
        makePlatform("spotify"),
        makePlatform("coming-soon-platform"),
        makePlatform("chatgpt"),
      ],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    })

    expect(cards[0].cardId).toBe("spotify")
    expect(cards[1].cardId).toBe("coming-soon-platform")
    expect(cards[2].cardId).toBe("chatgpt")
    // Injected registry entries appear after runtime platforms
    const injectedIdx = cards.findIndex(c => c.cardId === "test-coming-soon")
    expect(injectedIdx).toBeGreaterThan(2)
  })

  it("does not produce an onClick handler for comingSoon platforms", () => {
    const cards = buildAvailableCards({
      platforms: [
        makePlatform("coming-soon-platform"),
        makePlatform("chatgpt"),
      ],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    })

    const comingSoonCard = cards.find(c => c.cardId === "coming-soon-platform")
    const availableCard = cards.find(c => c.cardId === "chatgpt")

    expect(comingSoonCard?.onClick).toBeUndefined()
    expect(availableCard?.onClick).toBeDefined()

    availableCard?.onClick?.()
    expect(onExport).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chatgpt" })
    )
  })

  it("injects comingSoon registry entries that have no matching runtime platform", () => {
    const cards = buildAvailableCards({
      platforms: [makePlatform("chatgpt")],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    })

    const injectedCard = cards.find(c => c.cardId === "test-coming-soon")
    expect(injectedCard).toBeDefined()
    expect(injectedCard?.availability).toBe("comingSoon")
    expect(injectedCard?.isAvailable).toBe(false)
    expect(injectedCard?.onClick).toBeUndefined()
    expect(injectedCard?.iconImageSrc).toBe(
      "https://img.logo.dev/test-coming-soon.com?mock"
    )
  })

  it("does not duplicate a comingSoon entry already present as a runtime platform", () => {
    const cards = buildAvailableCards({
      platforms: [makePlatform("test-coming-soon")],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    })

    const matchingCards = cards.filter(c => c.cardId === "test-coming-soon")
    expect(matchingCards).toHaveLength(1)
  })

  it.each([
    [
      "legacy first",
      [
        makePlatform("github-playwright"),
        makePlatform("github-pdpp", { runtime: "pdpp-network" }),
      ],
    ],
    [
      "PDPP first",
      [
        makePlatform("github-pdpp", { runtime: "pdpp-network" }),
        makePlatform("github-playwright"),
      ],
    ],
  ])(
    "deduplicates canonical sources and prefers PDPP runtime when %s",
    (_order, platforms) => {
      const cards = buildAvailableCards({
        platforms,
        connectedPlatformIdSet: emptyConnected,
        connectingPlatforms: emptyConnecting,
        onExport,
      })

      expect(cards.filter(card => card.iconName === "GitHub")).toHaveLength(1)
      cards.find(card => card.iconName === "GitHub")?.onClick?.()
      expect(onExport).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "github-pdpp", runtime: "pdpp-network" })
      )
    }
  )

  it("canonicalizes legacy connected and running state onto the PDPP card", () => {
    const legacyRun = {
      id: "github-playwright-run",
      platformId: "github-playwright",
      status: "running",
    } as Run
    const cards = buildAvailableCards({
      platforms: [
        makePlatform("github-playwright"),
        makePlatform("github-pdpp", { runtime: "pdpp-network" }),
      ],
      connectedPlatformIdSet: new Set(["github-playwright"]),
      connectingPlatforms: new Map([["github-playwright", legacyRun]]),
      onExport,
    })

    expect(cards.find(card => card.iconName === "GitHub")).toBeUndefined()

    const runningCards = buildAvailableCards({
      platforms: [
        makePlatform("github-playwright"),
        makePlatform("github-pdpp", { runtime: "pdpp-network" }),
      ],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: new Map([["github-playwright", legacyRun]]),
      onExport,
    })
    expect(runningCards.find(card => card.iconName === "GitHub")).toMatchObject(
      {
        cardId: "github-pdpp",
        isConnecting: true,
        connectingRun: legacyRun,
      }
    )
  })

  it("keeps an installed source in the same slot while its install card becomes connect", () => {
    const sourceOrder = new Map<string, number>()
    const update = makeUpdate("new-source")
    const initialCards = buildAvailableCards({
      platforms: [makePlatform("spotify")],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
      connectorUpdates: [update],
      sourceOrder,
      onInstall: vi.fn(),
    })
    const initialOrder = initialCards.map(card => card.sourceKey)

    const installedCards = buildAvailableCards({
      platforms: [
        makePlatform("spotify"),
        makePlatform("new-source", { runtime: "pdpp-network" }),
      ],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
      connectorUpdates: [update],
      sourceOrder,
      onInstall: vi.fn(),
    })

    expect(installedCards.map(card => card.sourceKey)).toEqual(initialOrder)
    expect(
      installedCards.find(card => card.sourceKey === "new-source")
    ).toMatchObject({
      action: "connect",
      label: "Connect new-source",
    })
  })

  it("renders unavailable catalog entries at the bottom with their device reason", () => {
    const card = buildAvailableCards({
      platforms: [],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
      connectorUpdates: [
        makeUpdate("desktop-only", {
          name: "Desktop-only",
          runnable: false,
          unavailableReason: "Requires unavailable binding: desktop_session",
        }),
      ],
    }).find(source => source.sourceKey === "desktop-only")

    expect(card).toMatchObject({
      action: "unavailable",
      isAvailable: false,
      availabilityReason:
        "Not available on this device · Requires unavailable binding: desktop_session",
      onClick: undefined,
    })
  })

  it("marks a legacy runtime card with the legacy label", () => {
    const card = buildAvailableCards({
      platforms: [makePlatform("github-playwright", { runtime: "playwright" })],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    }).find(source => source.cardId === "github-playwright")

    expect(card?.label).toBe("Connect GitHub (legacy)")
  })

  it("labels a legacy source when a Collection Profile shares its display name", () => {
    const card = buildAvailableCards({
      platforms: [makePlatform("heb-playwright", { runtime: "playwright" })],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
      connectorUpdates: [makeUpdate("heb-pdpp", { name: "H-E-B" })],
    }).find(source => source.cardId === "heb-playwright")

    expect(card?.label).toBe("Add H-E-B (legacy)")
  })

  it("does not label an unrelated legacy source", () => {
    const card = buildAvailableCards({
      platforms: [makePlatform("spotify", { runtime: "playwright" })],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    }).find(source => source.cardId === "spotify")

    expect(card?.label).toBe("Connect Spotify")
  })

  it("renders X and Twitter as one canonical source card", () => {
    const cards = buildAvailableCards({
      platforms: [makePlatform("twitter"), makePlatform("x")],
      connectedPlatformIdSet: emptyConnected,
      connectingPlatforms: emptyConnecting,
      onExport,
    })

    expect(cards.filter(card => card.sourceKey === "x")).toHaveLength(1)
  })
})
