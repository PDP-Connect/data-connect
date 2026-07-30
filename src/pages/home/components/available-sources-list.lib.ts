import { getPlatformRegistryEntry } from "@/lib/platform/utils"
import { resolvePlatformLogo } from "@/lib/platform/resolve-platform-logo"
import {
  PLATFORM_REGISTRY,
  type PlatformRegistryAvailability,
} from "@/lib/platform/registry"
import { getPlatformLogoUrlForDomain } from "@/lib/platform/logo-provider"
import type { Platform, Run } from "@/types"

export type CardAvailability = PlatformRegistryAvailability | "unknown"

export interface AvailableSourceCard {
  cardId: string
  iconName: string
  iconImageSrc?: string
  label: string
  isAvailable: boolean
  isConnecting: boolean
  connectingStatusMessage?: string
  connectingRun?: Run
  onClick?: () => void
  index: number
  availability: CardAvailability
}

interface BuildAvailableCardsInput {
  platforms: Platform[]
  connectedPlatformIdSet: Set<string>
  connectingPlatforms: Map<string, Run>
  onExport: (platform: Platform) => void
}

function canonicalPlatformKey(
  platform: Pick<Platform, "id"> & Partial<Pick<Platform, "name" | "company">>
) {
  return getPlatformRegistryEntry(platform)?.id ?? platform.id
}

function isPreferredRuntime(candidate: Platform, current: Platform) {
  return (
    candidate.runtime === "pdpp-network" && current.runtime !== "pdpp-network"
  )
}

export function buildAvailableCards({
  platforms,
  connectedPlatformIdSet,
  connectingPlatforms,
  onExport,
}: BuildAvailableCardsInput): AvailableSourceCard[] {
  const cards: AvailableSourceCard[] = []

  // A registry source can have both a legacy runtime and a PDPP runtime
  // installed. The Home surface is source-oriented, so choose one canonical
  // runtime (PDPP when present) before applying connected/running state.
  const canonicalPlatforms = new Map<string, { platform: Platform; index: number }>()
  for (const [index, platform] of platforms.entries()) {
    const canonicalKey = canonicalPlatformKey(platform)
    const current = canonicalPlatforms.get(canonicalKey)
    if (!current || isPreferredRuntime(platform, current.platform)) {
      canonicalPlatforms.set(canonicalKey, { platform, index })
    }
  }

  const connectedCanonicalKeys = new Set(
    [...connectedPlatformIdSet].map(id => canonicalPlatformKey({ id }))
  )
  const connectingByCanonicalKey = new Map<string, Run>()
  for (const [platformId, run] of connectingPlatforms) {
    const canonicalKey = canonicalPlatformKey({ id: platformId })
    if (!connectingByCanonicalKey.has(canonicalKey)) {
      connectingByCanonicalKey.set(canonicalKey, run)
    }
  }

  for (const { platform, index } of canonicalPlatforms.values()) {
    const canonicalKey = canonicalPlatformKey(platform)
    if (connectedCanonicalKeys.has(canonicalKey)) continue

    const entry = getPlatformRegistryEntry(platform)
    const displayName = entry?.displayName ?? platform.name
    const baseConnectingRun = connectingByCanonicalKey.get(canonicalKey)
    const isConnecting = connectingByCanonicalKey.has(canonicalKey)
    const availability: CardAvailability = entry?.availability ?? "unknown"
    const isCardAvailable = availability !== "comingSoon"

    const iconImageSrc = resolvePlatformLogo(platform, entry)

    cards.push({
      cardId: platform.id,
      iconName: displayName,
      iconImageSrc,
      label: `Connect ${displayName}`,
      isAvailable: isCardAvailable,
      isConnecting,
      connectingStatusMessage: baseConnectingRun?.statusMessage,
      connectingRun: baseConnectingRun,
      onClick: isCardAvailable ? () => onExport(platform) : undefined,
      index,
      availability,
    })
  }

  // Inject registry-only "comingSoon" entries that have no matching runtime platform
  const existingCardIds = new Set(cards.map(c => c.cardId))

  PLATFORM_REGISTRY.filter(
    entry => entry.availability === "comingSoon"
  ).forEach(entry => {
    // Skip if a card already exists for any of this entry's platform IDs or its own ID
    const allIds = [entry.id, ...(entry.platformIds ?? [])]
    if (allIds.some(id => existingCardIds.has(id))) return

    const iconImageSrc = entry.brandDomain
      ? getPlatformLogoUrlForDomain(entry.brandDomain, { theme: "dark" })
      : undefined

    cards.push({
      cardId: entry.id,
      iconName: entry.displayName,
      iconImageSrc,
      label: `Connect ${entry.displayName}`,
      isAvailable: false,
      isConnecting: false,
      onClick: undefined,
      index: cards.length,
      availability: "comingSoon",
    })
  })

  cards.sort((a, b) => a.index - b.index)
  return cards
}
