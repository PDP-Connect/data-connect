// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  SourceRowList,
  SourceRowActionButton,
  SourceRowWithActions,
} from "@/components/elements/source-row"
import { ActionPanel } from "@/components/typography/button-action"
import { Text } from "@/components/typography/text"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ROUTES } from "@/config/routes"
import { cn } from "@/lib/classes"
import { getLastRunLabel } from "@/lib/platform/ui"
import { getPlatformRegistryEntry } from "@/lib/platform/utils"
import { resolvePlatformLogo } from "@/lib/platform/resolve-platform-logo"
import type { Platform, Run } from "@/types"
import {
  ChevronRightIcon,
  KeyRoundIcon,
  RotateCcwIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react"
import { Link } from "react-router-dom"
import { isBlockingRun } from "./available-sources-list.policy"
import { getPlatformSourceLabel } from "./available-sources-list.lib"

interface ConnectedSourcesListProps {
  platforms: Platform[]
  runs: Run[]
  headline?: string
  onOpenRuns?: (platform: Platform) => void
  onSyncSource?: (platform: Platform) => void
  onReconnectSource?: (platform: Platform) => void
  onReplaceCredentials?: (platform: Platform) => void
  onRemoveSource?: (platform: Platform) => void
  onAddAccount?: (platform: Platform) => void
}

type OnboardingMessageState = "empty" | "early" | "mature"
type SyncSourceFeedbackState = "running" | "backgrounding"

function getOnboardingMessageState(
  connectedSourceCount: number
): OnboardingMessageState {
  if (connectedSourceCount === 0) return "empty"
  if (connectedSourceCount <= 2) return "early"
  return "mature"
}

export function ConnectedSourcesList({
  platforms,
  runs,
  headline = "Your sources at the moment.",
  onOpenRuns,
  onSyncSource,
  onReconnectSource,
  onReplaceCredentials,
  onRemoveSource,
  onAddAccount,
}: ConnectedSourcesListProps) {
  const inFlightSyncPlatformIdsRef = useRef<Set<string>>(new Set())
  const syncFeedbackTimeoutsRef = useRef<
    Record<string, ReturnType<typeof setTimeout>[]>
  >({})
  const [syncFeedbackByPlatformId, setSyncFeedbackByPlatformId] = useState<
    Record<string, SyncSourceFeedbackState>
  >({})
  const clearSyncFeedbackTimers = useCallback((platformId: string) => {
    const existingTimers = syncFeedbackTimeoutsRef.current[platformId] ?? []
    existingTimers.forEach(timer => clearTimeout(timer))
    delete syncFeedbackTimeoutsRef.current[platformId]
  }, [])
  const clearSyncFeedbackForPlatform = useCallback(
    (platformId: string) => {
      inFlightSyncPlatformIdsRef.current.delete(platformId)
      clearSyncFeedbackTimers(platformId)
      setSyncFeedbackByPlatformId(prev => {
        if (!(platformId in prev)) return prev
        const { [platformId]: _ignored, ...rest } = prev
        return rest
      })
    },
    [clearSyncFeedbackTimers]
  )
  const triggerSyncFeedback = useCallback(
    (platform: Platform) => {
      if (!onSyncSource) return
      const platformKey = platform.connectionId
        ? `${platform.id}:${platform.connectionId}`
        : platform.id
      if (inFlightSyncPlatformIdsRef.current.has(platformKey)) return

      inFlightSyncPlatformIdsRef.current.add(platformKey)
      try {
        onSyncSource(platform)
      } catch (error) {
        console.error("Sync source failed before starting:", error)
        clearSyncFeedbackForPlatform(platformKey)
        return
      }
      clearSyncFeedbackTimers(platformKey)
      setSyncFeedbackByPlatformId(prev => ({
        ...prev,
        [platformKey]: "running",
      }))

      const moveToBackgroundTimer = setTimeout(() => {
        setSyncFeedbackByPlatformId(prev => ({
          ...prev,
          [platformKey]: "backgrounding",
        }))
      }, 3_000)

      const clearFeedbackTimer = setTimeout(() => {
        clearSyncFeedbackForPlatform(platformKey)
      }, 5_000)

      syncFeedbackTimeoutsRef.current[platformKey] = [
        moveToBackgroundTimer,
        clearFeedbackTimer,
      ]
    },
    [clearSyncFeedbackForPlatform, clearSyncFeedbackTimers, onSyncSource]
  )
  useEffect(() => {
    return () => {
      Object.values(syncFeedbackTimeoutsRef.current).forEach(timers => {
        timers.forEach(timer => clearTimeout(timer))
      })
      syncFeedbackTimeoutsRef.current = {}
      inFlightSyncPlatformIdsRef.current.clear()
    }
  }, [])

  const onboardingMessageState = getOnboardingMessageState(platforms.length)
  const activePlatformIds = useMemo(
    () =>
      new Set(
        runs.filter(run => run.status === "running").map(run =>
          run.connectionId ? `${run.platformId}:${run.connectionId}` : run.platformId
        )
      ),
    [runs]
  )

  if (platforms.length === 0) {
    return (
      <section className="space-y-gap">
        <div className="space-y-1">
          <Text as="h2" weight="medium">
            {headline}
          </Text>
          <PersonalServerOnboardingCopy state={onboardingMessageState} />
        </div>
        <div className="action-outset">
          <ActionPanel>
            <Text weight="medium">No sources yet</Text>
          </ActionPanel>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-gap">
      <div className="space-y-1">
        <Text as="h2" weight="medium">
          {headline}
        </Text>
        <PersonalServerOnboardingCopy state={onboardingMessageState} />
      </div>
      <SourceRowList>
        {platforms.map((platform, index) => {
          const rowKey = platform.connectionId
            ? `${platform.id}:${platform.connectionId}`
            : platform.id
          const meta = getLastRunLabel(
            platform.connectionId
              ? runs.filter(run => run.connectionId === platform.connectionId)
              : runs,
            platform.id
          )
          const hasActiveRun = activePlatformIds.has(rowKey)
          const hasBlockingRun = runs.some(
            run =>
              isBlockingRun(run) &&
              (!platform.connectionId || run.connectionId === platform.connectionId)
          )
          const syncFeedbackState = syncFeedbackByPlatformId[rowKey]
          const isShowingSyncFeedback = Boolean(syncFeedbackState)
          const accountCount = platforms.filter(
            candidate => candidate.id === platform.id
          ).length
          const accountOrdinal = platforms
            .slice(0, index + 1)
            .filter(candidate => candidate.id === platform.id).length
          const sourceLabel = platform.connectionId
            ? platform.name
            : getPlatformSourceLabel(platform)
          const rowLabel = platform.accountLabel
            ? `${sourceLabel} · ${platform.accountLabel}`
            : accountCount > 1
              ? `${sourceLabel} · Account ${accountOrdinal}`
              : sourceLabel
          const actionLabel = platform.connectionId ? rowLabel : platform.name
          const isSyncDisabled =
            !onSyncSource ||
            hasBlockingRun ||
            hasActiveRun ||
            isShowingSyncFeedback
          const canReconnect =
            platform.id === "chatgpt-pdpp" &&
            Boolean(onReconnectSource) &&
            !hasActiveRun
          const canReplaceCredentials =
            Boolean(onReplaceCredentials) &&
            (platform.id === "github-pdpp" ||
              platform.setup?.modality === "static_secret") &&
            !hasActiveRun
          const canRemove = Boolean(onRemoveSource) && !hasActiveRun
          const syncTooltipCopy =
            hasActiveRun || syncFeedbackState === "backgrounding"
              ? "Fetching in background"
              : syncFeedbackState === "running"
                ? "Fetching latest data"
                : "Fetch your latest data"
          return (
            <SourceRowWithActions
              key={rowKey}
              iconName={platform.name}
              iconImageSrc={resolvePlatformLogo(
                platform,
                getPlatformRegistryEntry(platform)
              )}
              label={rowLabel}
              meta={meta}
              rowAction={{
                onClick: onOpenRuns ? () => onOpenRuns(platform) : undefined,
                disabled: !onOpenRuns,
                ariaLabel: `Open ${rowLabel}`,
              }}
              middleSlot={
                <div className="flex h-full">
                  {platform.runtime === "pdpp-network" && onAddAccount ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SourceRowActionButton
                          className="px-2"
                          onClick={() => onAddAccount(platform)}
                          aria-label={`Add another ${platform.name} account`}
                        >
                          <UserPlusIcon aria-hidden />
                        </SourceRowActionButton>
                      </TooltipTrigger>
                      <TooltipContent side="top">Add another account</TooltipContent>
                    </Tooltip>
                  ) : null}
                  {canReplaceCredentials ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SourceRowActionButton
                          className="px-2"
                          onClick={() => onReplaceCredentials?.(platform)}
                          aria-label={`Replace credentials for ${platform.name}`}
                        >
                          <KeyRoundIcon aria-hidden />
                        </SourceRowActionButton>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        Replace credentials
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {canReconnect ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SourceRowActionButton
                          className="px-2"
                          onClick={() => onReconnectSource?.(platform)}
                          aria-label={`Reconnect ${platform.name}`}
                        >
                          <RotateCcwIcon aria-hidden />
                        </SourceRowActionButton>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        Reset this browser session and reconnect
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {canRemove ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SourceRowActionButton
                          className="px-2"
                          onClick={() => onRemoveSource?.(platform)}
                          aria-label={`Remove ${actionLabel}`}
                        >
                          <Trash2Icon aria-hidden />
                        </SourceRowActionButton>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        Remove this source
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SourceRowActionButton
                        className={cn("gap-2.5 pl-3.5 pr-3.5 justify-start")}
                        onClick={
                          !isSyncDisabled
                            ? () => triggerSyncFeedback(platform)
                            : undefined
                        }
                        disabled={isSyncDisabled}
                        aria-label={`Fetch latest data for ${actionLabel}`}
                      >
                        {syncFeedbackState ? (
                          <Text
                            as="span"
                            intent="fine"
                            muted
                            className="mt-[0.3em]"
                          >
                            {syncFeedbackState === "running"
                              ? "Fetching…"
                              : "Backgrounding…"}
                          </Text>
                        ) : null}
                        <RotateCcwIcon
                          className={cn(
                            syncFeedbackState &&
                              "animate-[spin_2s_linear_infinite_reverse]"
                          )}
                          aria-hidden
                        />
                      </SourceRowActionButton>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {syncTooltipCopy}
                    </TooltipContent>
                  </Tooltip>
                </div>
              }
              endSlotClassName="[&_svg:not([class*='size-']):not([data-slot=spinner])]:size-7!"
              surface="list-item"
              endSlot={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex h-full w-full items-center justify-center">
                      <ChevronRightIcon aria-hidden />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    View data source details
                  </TooltipContent>
                </Tooltip>
              }
            />
          )
        })}
      </SourceRowList>
    </section>
  )
}

interface PersonalServerOnboardingCopyProps {
  state: OnboardingMessageState
}

const ONBOARDING_COPY: Record<
  OnboardingMessageState,
  {
    serverText: string
    beforeServer: string
    afterServer: string
    appsCtaLink: string
    afterAppsLink: string
  }
> = {
  empty: {
    beforeServer: "Your ",
    serverText: "Personal Server",
    afterServer: " is ready. Connect a source to ",
    appsCtaLink: "run apps",
    afterAppsLink: " on it.",
  },
  early: {
    beforeServer: "Your data lives in your ",
    serverText: "Personal Server",
    afterServer: ". You can now ",
    appsCtaLink: "run apps",
    afterAppsLink: " on it.",
  },
  mature: {
    beforeServer: "Managed by your ",
    serverText: "Personal Server",
    afterServer: ". You can ",
    appsCtaLink: "run apps",
    afterAppsLink: " on it.",
  },
}

function PersonalServerOnboardingCopy({
  state,
}: PersonalServerOnboardingCopyProps) {
  const copy = ONBOARDING_COPY[state]

  return (
    <Text as="p" intent="small" muted>
      {copy.beforeServer}
      {copy.serverText}
      {copy.afterServer}
      <Link to={ROUTES.apps} className="link hover:text-foreground">
        {copy.appsCtaLink}
      </Link>
      {copy.afterAppsLink}
    </Text>
  )
}
