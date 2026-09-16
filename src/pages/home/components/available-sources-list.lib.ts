// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { getPlatformRegistryEntry } from "@/lib/platform/utils"
import { resolvePlatformLogo } from "@/lib/platform/resolve-platform-logo"
import {
  PLATFORM_REGISTRY,
  type PlatformRegistryAvailability,
} from "@/lib/platform/registry"
import { getPlatformLogoUrlForDomain } from "@/lib/platform/logo-provider"
import type { ConnectorUpdateInfo, Platform, Run } from "@/types"

export type CardAvailability = PlatformRegistryAvailability | "unknown"
export type AvailableSourceCardAction =
  "connect" | "install" | "update" | "unavailable" | "comingSoon"

export interface AvailableSourceCard {
  cardId: string
  sourceKey: string
  iconName: string
  iconImageSrc?: string
  label: string
  action: AvailableSourceCardAction
  tier?: "preview" | "development"
  availabilityReason?: string
  actionError?: string
  isInstalling: boolean
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
  connectorUpdates?: ConnectorUpdateInfo[]
  onInstall?: (id: string) => void
  onRetry?: (id: string) => void
  isInstalling?: (id: string) => boolean
  isApplying?: (id: string) => boolean
  isUnapplied?: (id: string) => boolean
  downloadErrors?: Record<string, string>
  /** Retained by the component so an installed card keeps its grid position. */
  sourceOrder?: Map<string, number>
}

function canonicalPlatformKey(
  platform: Pick<Platform, "id"> & Partial<Pick<Platform, "name" | "company">>
) {
  return getPlatformRegistryEntry(platform)?.id ?? platform.id
}

function canonicalUpdateKey(update: ConnectorUpdateInfo) {
  return (
    getPlatformRegistryEntry({
      id: update.id,
      name: update.name,
      company: update.company,
    })?.id ?? update.id
  )
}

function isPreferredRuntime(candidate: Platform, current: Platform) {
  return (
    candidate.runtime === "pdpp-network" && current.runtime !== "pdpp-network"
  )
}

function updatePriority(update: ConnectorUpdateInfo) {
  if (!update.runnable) return 3
  if (update.isNew) return 2
  if (update.hasUpdate) return 1
  return 0
}

function deduplicateUpdates(updates: ConnectorUpdateInfo[]) {
  const bySource = new Map<string, ConnectorUpdateInfo>()
  for (const update of updates) {
    const sourceKey = canonicalUpdateKey(update)
    const current = bySource.get(sourceKey)
    if (!current || updatePriority(update) > updatePriority(current)) {
      bySource.set(sourceKey, update)
    }
  }
  return bySource
}

function getTier(tier: string): "preview" | "development" | undefined {
  if (tier === "preview" || tier === "development") return tier
  return undefined
}

function hasCollectionProfileVariant(
  entry: ReturnType<typeof getPlatformRegistryEntry>,
  update?: ConnectorUpdateInfo
) {
  return (
    (entry?.platformIds?.some(id => /(?:^|-|_)pdpp(?:-|$)/i.test(id)) ??
      false) ||
    (update?.isNew ?? false)
  )
}

function sourceLabel(
  action: Exclude<AvailableSourceCardAction, "comingSoon">,
  displayName: string,
  platform: Platform | undefined,
  collectionProfileAvailable: boolean,
  isApplying = false,
  isUnapplied = false
) {
  const actionLabel = isUnapplied
    ? "Installed but not applied"
    : isApplying
      ? "Applying…"
      : action === "install"
        ? "Install"
        : action === "update"
          ? "Update"
          : "Connect"
  const legacyLabel =
    platform &&
    platform.runtime !== "pdpp-network" &&
    collectionProfileAvailable
      ? " (legacy)"
      : ""
  return `${actionLabel} ${displayName}${isUnapplied ? " · Retry" : ""}${legacyLabel}`
}

function createOrderTracker(sourceOrder?: Map<string, number>) {
  const order = sourceOrder ?? new Map<string, number>()
  let nextOrder = Math.max(-1, ...order.values()) + 1
  return (sourceKey: string, fallback: number) => {
    const current = order.get(sourceKey)
    if (current !== undefined) return current
    const next = sourceOrder ? nextOrder++ : fallback
    order.set(sourceKey, next)
    return next
  }
}

export function getPlatformSourceLabel(platform: Platform) {
  const entry = getPlatformRegistryEntry(platform)
  const displayName = entry?.displayName ?? platform.name
  return sourceLabel(
    "connect",
    displayName,
    platform,
    hasCollectionProfileVariant(entry)
  ).replace(/^Connect /, "")
}

export function buildAvailableCards({
  platforms,
  connectedPlatformIdSet,
  connectingPlatforms,
  onExport,
  connectorUpdates = [],
  onInstall,
  onRetry,
  isInstalling = () => false,
  isApplying = () => false,
  isUnapplied = () => false,
  downloadErrors = {},
  sourceOrder,
}: BuildAvailableCardsInput): AvailableSourceCard[] {
  const cards: AvailableSourceCard[] = []
  const rememberOrder = createOrderTracker(sourceOrder)
  const updatesBySource = deduplicateUpdates(connectorUpdates)
  const handledUpdateSources = new Set<string>()

  // A registry source can have both a legacy runtime and a PDPP runtime
  // installed. The Home surface is source-oriented, so choose one canonical
  // runtime (PDPP when present) before applying connected/running state.
  const canonicalPlatforms = new Map<
    string,
    { platform: Platform; index: number }
  >()
  for (const [index, platform] of platforms.entries()) {
    const sourceKey = canonicalPlatformKey(platform)
    const current = canonicalPlatforms.get(sourceKey)
    if (!current || isPreferredRuntime(platform, current.platform)) {
      canonicalPlatforms.set(sourceKey, { platform, index })
    }
    rememberOrder(sourceKey, index)
  }

  const connectedCanonicalKeys = new Set(
    [...connectedPlatformIdSet].map(id => canonicalPlatformKey({ id }))
  )
  const connectingByCanonicalKey = new Map<string, Run>()
  for (const [platformId, run] of connectingPlatforms) {
    const sourceKey = canonicalPlatformKey({ id: platformId })
    if (!connectingByCanonicalKey.has(sourceKey)) {
      connectingByCanonicalKey.set(sourceKey, run)
    }
  }

  const addUpdateCard = ({
    update,
    platform,
    sourceKey,
    index,
    action,
    entry,
  }: {
    update: ConnectorUpdateInfo
    platform?: Platform
    sourceKey: string
    index: number
    action: Exclude<AvailableSourceCardAction, "connect" | "comingSoon">
    entry: ReturnType<typeof getPlatformRegistryEntry>
  }) => {
    const displayName = entry?.displayName ?? update.name
    const isUnavailable = action === "unavailable"
    const isCurrentlyUnapplied = isUnapplied(update.id)
    const isCurrentlyInstalling =
      !isCurrentlyUnapplied && isInstalling(update.id)
    const isCurrentlyApplying =
      !isCurrentlyUnapplied && isApplying(update.id)
    const reason =
      update.unavailableReason ??
      "This device does not provide the required capability"
    cards.push({
      cardId: platform?.id ?? update.id,
      sourceKey,
      iconName: displayName,
      iconImageSrc: platform ? resolvePlatformLogo(platform, entry) : undefined,
      label: sourceLabel(
        action,
        displayName,
        platform,
        hasCollectionProfileVariant(entry, update),
        isCurrentlyApplying,
        isCurrentlyUnapplied
      ),
      action,
      tier: getTier(update.tier),
      availabilityReason: isUnavailable
        ? `Not available on this device · ${reason}`
        : undefined,
      actionError: downloadErrors[update.id] || undefined,
      isInstalling: isCurrentlyInstalling || isCurrentlyApplying,
      isAvailable: !isUnavailable && update.runnable,
      isConnecting: false,
      onClick:
        isCurrentlyUnapplied && onRetry
          ? () => onRetry(update.id)
          : isUnavailable ||
              isCurrentlyInstalling ||
              isCurrentlyApplying ||
              !onInstall
            ? undefined
            : () => onInstall(update.id),
      index: rememberOrder(sourceKey, index),
      availability: entry?.availability ?? "unknown",
    })
    handledUpdateSources.add(sourceKey)
  }

  for (const { platform, index } of canonicalPlatforms.values()) {
    const sourceKey = canonicalPlatformKey(platform)
    const update = updatesBySource.get(sourceKey)
    const entry = getPlatformRegistryEntry(platform)
    const displayName = entry?.displayName ?? platform.name

    // A failed capability check wins over an installed runtime: the row is a
    // clear, disabled explanation and never offers an install path.
    if (update && !update.runnable) {
      addUpdateCard({
        update,
        platform,
        sourceKey,
        index,
        action: "unavailable",
        entry,
      })
      continue
    }

    // A new Collection Profile replaces a legacy runtime's available card so
    // the user sees the install action for the canonical source once.
    if (update?.isNew && platform.runtime !== "pdpp-network") {
      addUpdateCard({
        update,
        platform,
        sourceKey,
        index,
        action: "install",
        entry,
      })
      continue
    }

    if (connectedCanonicalKeys.has(sourceKey)) continue

    const connectingRun = connectingByCanonicalKey.get(sourceKey)
    const isConnecting = connectingByCanonicalKey.has(sourceKey)
    const availability: CardAvailability = entry?.availability ?? "unknown"
    const isCardAvailable = availability !== "comingSoon"
    const isUpdating = Boolean(update && !update.isNew && update.hasUpdate)
    const isCurrentlyUnapplied =
      isUnapplied(platform.id) || (update ? isUnapplied(update.id) : false)
    const isCurrentlyApplying =
      !isCurrentlyUnapplied &&
      (isApplying(platform.id) || (update ? isApplying(update.id) : false))
    const isCurrentlyInstalling =
      !isCurrentlyUnapplied && (update ? isInstalling(update.id) : false)
    const retryId = update && isUnapplied(update.id) ? update.id : platform.id
    const cardAction: Exclude<
      AvailableSourceCardAction,
      "install" | "unavailable" | "comingSoon"
    > = isUpdating ? "update" : "connect"

    cards.push({
      cardId: platform.id,
      sourceKey,
      iconName: displayName,
      iconImageSrc: resolvePlatformLogo(platform, entry),
      label: sourceLabel(
        cardAction,
        displayName,
        platform,
        hasCollectionProfileVariant(entry, update),
        isCurrentlyApplying,
        isCurrentlyUnapplied
      ),
      action: cardAction,
      tier: update ? getTier(update.tier) : undefined,
      actionError: update ? downloadErrors[update.id] || undefined : undefined,
      isInstalling: isCurrentlyInstalling || isCurrentlyApplying,
      isAvailable: isCardAvailable,
      isConnecting,
      connectingStatusMessage: connectingRun?.statusMessage,
      connectingRun,
      onClick:
        isCurrentlyUnapplied && onRetry
          ? () => onRetry(retryId)
          : isCurrentlyInstalling || isCurrentlyApplying
            ? undefined
            : isUpdating && onInstall && update
              ? () => onInstall(update.id)
              : isCardAvailable
                ? () => onExport(platform)
                : undefined,
      index: rememberOrder(sourceKey, index),
      availability,
    })
    if (update) handledUpdateSources.add(sourceKey)
  }

  // New catalog connectors have no Platform until installation completes, so
  // render them as the same source card with an install action.
  for (const [updateIndex, update] of updatesBySource.entries()) {
    if (handledUpdateSources.has(updateIndex)) continue
    const entry = getPlatformRegistryEntry({
      id: update.id,
      name: update.name,
      company: update.company,
    })
    const action: Exclude<AvailableSourceCardAction, "connect" | "comingSoon"> =
      !update.runnable ? "unavailable" : update.isNew ? "install" : "update"
    addUpdateCard({
      update,
      sourceKey: updateIndex,
      index:
        platforms.length + [...updatesBySource.keys()].indexOf(updateIndex),
      action,
      entry,
    })
  }

  // Inject registry-only coming-soon entries that have no matching runtime
  // platform or catalog connector. Unavailable device rows sort below these.
  for (const [entryIndex, entry] of PLATFORM_REGISTRY.entries()) {
    if (entry.availability !== "comingSoon") continue
    const sourceKey = entry.id
    if (cards.some(card => card.sourceKey === sourceKey)) continue

    const iconImageSrc = entry.brandDomain
      ? getPlatformLogoUrlForDomain(entry.brandDomain, { theme: "dark" })
      : undefined

    cards.push({
      cardId: entry.id,
      sourceKey,
      iconName: entry.displayName,
      iconImageSrc,
      label: `Connect ${entry.displayName}`,
      action: "comingSoon",
      isInstalling: false,
      isAvailable: false,
      isConnecting: false,
      onClick: undefined,
      index: rememberOrder(
        sourceKey,
        platforms.length + connectorUpdates.length + entryIndex
      ),
      availability: "comingSoon",
    })
  }

  cards.sort((a, b) => {
    const unavailableOrder = (card: AvailableSourceCard) =>
      card.action === "unavailable" ? 2 : card.action === "comingSoon" ? 1 : 0
    return unavailableOrder(a) - unavailableOrder(b) || a.index - b.index
  })
  return cards
}
