// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowUpRight } from "lucide-react"
import { useDispatch, useSelector } from "react-redux"
import {
  ActionButton,
  ActionPanel,
  actionButtonSurfaceClass,
} from "@/components/typography/button-action"
import { EyebrowBadge } from "@/components/typography/eyebrow-badge"
import { Text } from "@/components/typography/text"
import { Spinner } from "@/components/elements/spinner"
import { SourceStack } from "@/components/elements/source-stack"
import { cn } from "@/lib/classes"
import type { Platform, Run } from "@/types"
import { OpenExternalLink } from "@/components/typography/link-open-external"
import { buildAvailableCards } from "./available-sources-list.lib"
import { ConnectorUpdatesRefreshButton } from "./connector-updates"
import { ConfirmAction } from "@/components/elements/confirm-action"
import { buttonVariants } from "@/components/ui/button"
import { buildRunningImportExpectationLine } from "./available-sources-estimator"
import { useConnectorUpdates } from "@/hooks/useConnectorUpdates"
import { usePersonalServer } from "@/hooks/usePersonalServer"
import { useShowDevelopmentConnectors } from "@/hooks/use-show-development-connectors"
import {
  clearConnectorChangePending,
  markConnectorChangePending,
} from "@/state/store"
import type { RootState } from "@/state/store"
import {
  getConnectingAccountLine,
  getConnectingStatusLine,
  isBlockingRun,
} from "./available-sources-list.policy"

interface AvailableSourcesListProps {
  platforms: Platform[]
  runs: Run[]
  onExport: (platform: Platform) => void
  onStopRun: (runId: string) => Promise<void> | void
  connectedPlatformIds: string[]
  onReloadPlatforms?: () => Promise<void> | void
  className?: string
}

export function AvailableSourcesList({
  platforms,
  runs,
  onExport,
  onStopRun,
  connectedPlatformIds,
  onReloadPlatforms,
  className,
}: AvailableSourcesListProps) {
  const dispatch = useDispatch()
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)
  const [isApplyingConnectorChange, setIsApplyingConnectorChange] =
    useState(false)
  const [localPendingConnectorChanges, setLocalPendingConnectorChanges] =
    useState<Set<string>>(() => new Set())
  const applyInFlightRef = useRef(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [sourceOrder] = useState(() => new Map<string, number>())
  const pendingConnectorChanges = useSelector(
    (state: RootState) => state.app.pendingConnectorChanges ?? []
  )
  const {
    updates,
    isCheckingUpdates,
    error: updatesError,
    downloadErrors,
    checkForUpdates,
    downloadConnector,
    isDownloading,
  } = useConnectorUpdates()
  const { status: personalServerStatus, restartServer } = usePersonalServer()
  const { showDevelopmentConnectors } = useShowDevelopmentConnectors()
  const connectedPlatformIdSet = useMemo(
    () => new Set(connectedPlatformIds),
    [connectedPlatformIds]
  )
  // Maps platformId → run object for status + phase + account hint rendering.
  const connectingPlatforms = useMemo(() => {
    const map = new Map<string, Run>()
    runs
      .filter(run => run.status === "running")
      .forEach(run => {
        map.set(run.platformId, run)
      })
    return map
  }, [runs])

  const hasBlockingRun = useMemo(() => {
    return runs.some(run => isBlockingRun(run))
  }, [runs])
  const hasActiveRuns = useMemo(
    () =>
      runs.some(run => run.status === "running" || run.status === "pending"),
    [runs]
  )
  const pendingConnectorIds = useMemo(
    () =>
      new Set([...pendingConnectorChanges, ...localPendingConnectorChanges]),
    [localPendingConnectorChanges, pendingConnectorChanges]
  )

  const visibleUpdates = useMemo(
    () =>
      updates.filter(
        update => update.tier !== "development" || showDevelopmentConnectors
      ),
    [showDevelopmentConnectors, updates]
  )

  const markPending = useCallback(
    (id: string) => {
      setLocalPendingConnectorChanges(current => {
        if (current.has(id)) return current
        const next = new Set(current)
        next.add(id)
        return next
      })
      dispatch(markConnectorChangePending(id))
    },
    [dispatch]
  )

  const clearPending = useCallback(
    (ids: string[]) => {
      setLocalPendingConnectorChanges(current => {
        const next = new Set(current)
        ids.forEach(id => next.delete(id))
        return next
      })
      ids.forEach(id => dispatch(clearConnectorChangePending(id)))
    },
    [dispatch]
  )

  const applyPendingConnectorChanges = useCallback(async () => {
    if (
      applyInFlightRef.current ||
      hasActiveRuns ||
      pendingConnectorIds.size === 0
    ) {
      return
    }

    applyInFlightRef.current = true
    const idsToApply = [...pendingConnectorIds]
    setIsApplyingConnectorChange(true)
    try {
      if (personalServerStatus === "running") {
        await restartServer()
      }
      await onReloadPlatforms?.()
    } finally {
      clearPending(idsToApply)
      applyInFlightRef.current = false
      setIsApplyingConnectorChange(false)
    }
  }, [
    clearPending,
    hasActiveRuns,
    onReloadPlatforms,
    pendingConnectorIds,
    personalServerStatus,
    restartServer,
  ])

  const installConnector = useCallback(
    async (id: string) => {
      const installed = await downloadConnector(id)
      if (installed) markPending(id)
    },
    [downloadConnector, markPending]
  )

  useEffect(() => {
    void applyPendingConnectorChanges()
  }, [applyPendingConnectorChanges])

  useEffect(() => {
    const hasRunning = runs.some(run => run.status === "running")
    if (!hasRunning) return

    const interval = window.setInterval(() => {
      setNowMs(Date.now())
    }, 15000)

    return () => {
      window.clearInterval(interval)
    }
  }, [runs])

  const availableCards = useMemo(
    () =>
      buildAvailableCards({
        platforms,
        connectedPlatformIdSet,
        connectingPlatforms,
        onExport,
        connectorUpdates: visibleUpdates,
        onInstall: id => {
          void installConnector(id)
        },
        isInstalling: id => isDownloading(id) || pendingConnectorIds.has(id),
        isApplying: id => pendingConnectorIds.has(id),
        downloadErrors,
        sourceOrder,
      }),
    [
      connectedPlatformIdSet,
      connectingPlatforms,
      downloadErrors,
      installConnector,
      isDownloading,
      onExport,
      platforms,
      sourceOrder,
      pendingConnectorIds,
      visibleUpdates,
    ]
  )

  const stopRun = async (runId: string) => {
    setStoppingRunId(runId)
    try {
      await onStopRun(runId)
    } finally {
      setStoppingRunId(current => (current === runId ? null : current))
    }
  }

  if (availableCards.length === 0) {
    return (
      <section className={cn("space-y-gap", className)}>
        <Header
          isCheckingUpdates={isCheckingUpdates}
          onRefresh={() => {
            void checkForUpdates(true)
          }}
        />
        {updatesError ? <UpdateError message={updatesError} /> : null}
        <div className="action-outset">
          <ActionPanel>
            <Text weight="medium">
              {isCheckingUpdates
                ? "Checking for connectors…"
                : "All connected (more soon)"}
            </Text>
          </ActionPanel>
        </div>
      </section>
    )
  }

  return (
    <section className={cn("space-y-gap", className)}>
      <Header
        isCheckingUpdates={isCheckingUpdates}
        onRefresh={() => {
          void checkForUpdates(true)
        }}
      />
      {isApplyingConnectorChange ? (
        <Text as="p" intent="fine" muted>
          Applying connector change…
        </Text>
      ) : pendingConnectorIds.size > 0 && hasActiveRuns ? (
        <Text as="p" intent="fine" muted>
          Will apply after the current import finishes
        </Text>
      ) : null}
      {updatesError ? <UpdateError message={updatesError} /> : null}
      <div className="grid grid-cols-2 gap-3 action-outset">
        {availableCards.map(
          ({
            cardId,
            iconName,
            iconImageSrc,
            label,
            tier,
            availabilityReason,
            actionError,
            isInstalling,
            isAvailable,
            isConnecting,
            connectingStatusMessage,
            connectingRun,
            onClick,
            availability,
          }) => {
            const connectingStatusLine = isConnecting
              ? getConnectingStatusLine(
                  connectingStatusMessage,
                  connectingRun?.phase?.label
                )
              : undefined
            const connectingAccountLine = isConnecting
              ? getConnectingAccountLine(connectingRun)
              : undefined
            const connectingExpectationLine =
              isConnecting && connectingRun
                ? buildRunningImportExpectationLine({
                    run: connectingRun,
                    runs,
                    nowMs,
                  })
                : undefined
            const isConnectingAndBlocking =
              isConnecting && connectingRun
                ? isBlockingRun(connectingRun)
                : false
            const isWaitingForBlockingRun =
              hasBlockingRun && isAvailable && !isConnecting

            const infoSlot = isConnecting ? (
              <div className="ml-auto flex max-w-full flex-col items-end gap-0.5">
                {connectingAccountLine ? (
                  <Text as="p" intent="fine" muted truncate align="right">
                    {connectingAccountLine}
                  </Text>
                ) : null}
                {connectingExpectationLine ? (
                  <Text as="p" intent="fine" muted truncate align="right">
                    {connectingExpectationLine}
                  </Text>
                ) : null}
                <Text as="p" intent="fine" muted truncate align="right">
                  {connectingStatusLine}
                </Text>
                {isConnectingAndBlocking ? (
                  <Text as="p" intent="fine" muted truncate align="right">
                    Finish sign-in to unlock other imports
                  </Text>
                ) : null}
                {connectingRun ? (
                  <ConfirmAction
                    title="Cancel import?"
                    description="This run will stop before completion. You can run it again later."
                    actionLabel="Stop import"
                    onAction={() => {
                      void stopRun(connectingRun.id)
                    }}
                    triggerLabel={
                      stoppingRunId === connectingRun.id
                        ? "Stopping…"
                        : "Cancel import"
                    }
                    triggerButtonProps={{
                      className: cn(
                        "h-auto p-0 text-fine font-normal link text-foreground-muted hover:text-foreground",
                        "disabled:pointer-events-none disabled:opacity-50"
                      ),
                      disabled: stoppingRunId === connectingRun.id,
                    }}
                  />
                ) : null}
              </div>
            ) : availabilityReason || actionError ? (
              <div className="ml-auto flex max-w-full flex-col items-end gap-0.5">
                {availabilityReason ? (
                  <Text
                    as="p"
                    intent="fine"
                    muted
                    truncate
                    align="right"
                    title={availabilityReason}
                  >
                    {availabilityReason}
                  </Text>
                ) : null}
                {actionError ? (
                  <Text
                    as="p"
                    intent="fine"
                    muted
                    truncate
                    align="right"
                    title={actionError}
                  >
                    Installation failed · {actionError}
                  </Text>
                ) : null}
              </div>
            ) : null

            const isWaiting = isWaitingForBlockingRun && !isInstalling

            const cardContent = (
              <SourceStack
                iconName={iconName}
                iconImageSrc={iconImageSrc}
                label={label}
                infoSlot={infoSlot}
                showArrow={
                  isAvailable &&
                  !isConnecting &&
                  !isInstalling &&
                  !hasBlockingRun
                }
                trailingSlot={
                  isConnecting ? (
                    <Spinner className="size-4" aria-hidden="true" />
                  ) : isInstalling ? (
                    <Spinner className="size-4" aria-hidden="true" />
                  ) : isWaiting ? (
                    <EyebrowBadge
                      variant="outline"
                      className="text-foreground-muted"
                      title="Another import is waiting for sign-in"
                    >
                      Waiting
                    </EyebrowBadge>
                  ) : tier ? (
                    <EyebrowBadge
                      variant="outline"
                      className="text-foreground-muted"
                    >
                      {tier === "preview" ? "Preview" : "Development"}
                    </EyebrowBadge>
                  ) : availability === "comingSoon" ? (
                    <EyebrowBadge
                      variant="outline"
                      className="text-foreground-muted"
                    >
                      Coming Soon
                    </EyebrowBadge>
                  ) : null
                }
                labelColor={isAvailable ? "foreground" : "mutedForeground"}
              />
            )

            if (isConnecting) {
              return (
                <div
                  key={cardId}
                  aria-busy
                  aria-selected
                  className={cn(
                    buttonVariants({
                      variant: "outline",
                      size: "xl",
                      fullWidth: true,
                    }),
                    actionButtonSurfaceClass,
                    "h-auto cursor-default p-0 transition-none"
                  )}
                >
                  {cardContent}
                </div>
              )
            }

            return (
              <ActionButton
                key={cardId}
                onClick={onClick}
                disabled={
                  !isAvailable ||
                  hasBlockingRun ||
                  isInstalling ||
                  isApplyingConnectorChange
                }
                selected={false}
                size="xl"
                className={cn("h-auto p-0 disabled:opacity-100")}
              >
                {cardContent}
              </ActionButton>
            )
          }
        )}
      </div>
    </section>
  )
}

function UpdateError({ message }: { message: string }) {
  return (
    <Text as="p" intent="fine" muted truncate title={message}>
      Connector refresh unavailable · {message}
    </Text>
  )
}

const Header = ({
  isCheckingUpdates,
  onRefresh,
}: {
  isCheckingUpdates: boolean
  onRefresh: () => void | Promise<void>
}) => {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-1">
        <Text as="h2" weight="medium" truncate>
          Import sources
        </Text>
        <ConnectorUpdatesRefreshButton
          isCheckingUpdates={isCheckingUpdates}
          onRefresh={onRefresh}
        />
      </div>
      <Text as="p" intent="small" muted>
        <OpenExternalLink
          href="https://github.com/PDP-Connect/data-connectors/blob/main/AUTHORING.md"
          intent="small"
          withIcon
        >
          Add your own
          <ArrowUpRight aria-hidden />
        </OpenExternalLink>
      </Text>
    </div>
  )
}
