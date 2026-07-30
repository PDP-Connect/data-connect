import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/elements/spinner"
import { PageContainer } from "@/components/elements/page-container"
import { PageHeading } from "@/components/typography/page-heading"
import { Text } from "@/components/typography/text"
import {
  createProductionTimelineDataSource,
  TIMELINE_MAX_RECORDS,
  type TimelineDataSource,
} from "@/apps/timeline/timeline-data-source"
import type {
  TimelineEvent,
  TimelineUndatedRecord,
} from "@/apps/timeline/timeline-derivation"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useTimelinePage } from "./use-timeline-page"
import { usePersonalServer } from "@/hooks/usePersonalServer"
import type { LocalTimelineConsentRequest } from "@/services/pdppTimeline"

type TimelineProps = {
  dataSource?: TimelineDataSource
}

export function Timeline({ dataSource: providedDataSource }: TimelineProps) {
  return providedDataSource ? (
    <TimelineContent dataSource={providedDataSource} />
  ) : (
    <ConnectedTimeline />
  )
}

function ConnectedTimeline() {
  const personalServer = usePersonalServer()
  const dataSource = useMemo(
    () =>
      createProductionTimelineDataSource({
        port: personalServer.port,
        devToken: personalServer.devToken,
      }),
    [personalServer.devToken, personalServer.port]
  )
  return <TimelineContent dataSource={dataSource} />
}

function TimelineContent({ dataSource }: { dataSource: TimelineDataSource }) {
  const {
    activeStreamId,
    setSelectedStreamId,
    state,
    timeline,
    visibleTimeline,
    requestConsent,
    approveConsent,
    loadMore,
    isLoadingMore,
    revokeConsent,
  } = useTimelinePage(dataSource)
  const [consentError, setConsentError] = useState<string | null>(null)
  const [pendingConsent, setPendingConsent] =
    useState<LocalTimelineConsentRequest | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const requestTerms = async () => {
    if (!requestConsent) return
    setConsentError(null)
    try {
      const consent = await requestConsent()
      if (consent) setPendingConsent(consent)
    } catch (error) {
      setConsentError(
        error instanceof Error
          ? error.message
          : "Timeline consent terms could not be loaded."
      )
    }
  }

  const approvePendingConsent = async () => {
    if (!approveConsent || !pendingConsent) return
    setConsentError(null)
    try {
      await approveConsent(pendingConsent)
      setPendingConsent(null)
    } catch (error) {
      setConsentError(
        error instanceof Error
          ? error.message
          : "Timeline consent could not be approved."
      )
    }
  }

  const revokeTimelineAccess = async () => {
    if (!revokeConsent) return
    setRevokeError(null)
    try {
      await revokeConsent()
      setPendingConsent(null)
      setConsentError(null)
    } catch (error) {
      setRevokeError(
        error instanceof Error
          ? error.message
          : "Timeline access could not be revoked."
      )
    }
  }

  return (
    <PageContainer>
      <section className="space-y-w8">
        <div className="space-y-2">
          <PageHeading>Timeline</PageHeading>
          <Text as="p" intent="small" muted>
            A chronological view of the records your connected sources share.
          </Text>
        </div>

        {state.kind === "loading" ? <TimelineLoading /> : null}
        {state.kind === "unauthorized" ? (
          pendingConsent ? (
            <TimelineConsentTerms
              consent={pendingConsent}
              error={consentError}
              onApprove={approveConsent ? approvePendingConsent : undefined}
              onCancel={() => {
                setConsentError(null)
                setPendingConsent(null)
              }}
            />
          ) : (
            <TimelineUnauthorized
              onRequestTerms={requestConsent ? requestTerms : undefined}
              error={consentError}
            />
          )
        ) : null}
        {state.kind === "revoked" ? <TimelineRevoked /> : null}
        {state.kind === "error" ? (
          <TimelineError message={state.message} />
        ) : null}
        {state.kind === "ready" && timeline && visibleTimeline ? (
          <TimelineReady
            activeStreamId={activeStreamId}
            onStreamChange={setSelectedStreamId}
            streams={timeline.streams}
            timeline={timeline}
            visibleTimeline={visibleTimeline}
            onLoadMore={loadMore}
            isLoadingMore={isLoadingMore}
            onRevokeAccess={revokeConsent ? revokeTimelineAccess : undefined}
            revokeError={revokeError}
          />
        ) : null}
      </section>
    </PageContainer>
  )
}

function TimelineLoading() {
  return (
    <Text as="p" intent="small" muted withIcon aria-live="polite">
      <Spinner />
      Loading timeline…
    </Text>
  )
}

function TimelineUnauthorized({
  onRequestTerms,
  error,
}: {
  onRequestTerms?: () => void
  error: string | null
}) {
  if (!onRequestTerms)
    return <TimelineStatus title="Sign in to view your timeline." />
  return (
    <section aria-live="polite" className="space-y-3">
      <Text as="h2" intent="heading">
        Allow Timeline to read your connected data
      </Text>
      <Text as="p" intent="small" muted>
        Timeline will request read access to the GitHub records available from
        your local Personal Server.
      </Text>
      <Button onClick={onRequestTerms}>Review local Timeline access</Button>
      {error ? (
        <Text as="p" intent="small" color="destructive">
          {error}
        </Text>
      ) : null}
    </section>
  )
}

function TimelineConsentTerms({
  consent,
  error,
  onApprove,
  onCancel,
}: {
  consent: LocalTimelineConsentRequest
  error: string | null
  onApprove?: () => void
  onCancel: () => void
}) {
  const terms = consent.authorization_details
  const retention = terms.retention
  const expiry = formatTimelineExpiry(consent.access_expires_in_seconds)

  return (
    <section aria-live="polite" className="space-y-3">
      <Text as="h2" intent="heading">
        Review Timeline access
      </Text>
      <Text as="p" intent="small" muted>
        Timeline is asking your local Personal Server for the following access.
      </Text>
      <dl className="space-y-2">
        <div>
          <Text as="dt" intent="fine" muted>
            Purpose
          </Text>
          <Text as="dd" intent="small">
            {terms.purpose_description ?? terms.purpose_code}
          </Text>
        </div>
        <div>
          <Text as="dt" intent="fine" muted>
            Verified GitHub streams
          </Text>
          <Text as="dd" intent="small">
            <ul className="list-disc pl-5">
              {terms.streams.map(stream => (
                <li key={stream.name}>{stream.name}</li>
              ))}
            </ul>
          </Text>
        </div>
        <div>
          <Text as="dt" intent="fine" muted>
            Access mode
          </Text>
          <Text as="dd" intent="small">
            {terms.access_mode === "continuous"
              ? "Continuous access while this approval remains active."
              : "Single-use access."}
          </Text>
        </div>
        {retention ? (
          <div>
            <Text as="dt" intent="fine" muted>
              Retention
            </Text>
            <Text as="dd" intent="small">
              {retention.max_duration}; {retention.on_expiry} on expiry.
            </Text>
          </div>
        ) : null}
      </dl>
      <Text as="p" intent="small" muted>
        This approval applies only to the local Personal Server on this device.
        {expiry} You can revoke it sooner.
      </Text>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {onApprove ? (
          <Button onClick={onApprove}>Approve local Timeline access</Button>
        ) : null}
      </div>
      {error ? (
        <Text as="p" intent="small" color="destructive">
          {error}
        </Text>
      ) : null}
    </section>
  )
}

function formatTimelineExpiry(seconds: number | undefined) {
  if (!seconds || seconds < 1) {
    return " Expiry is set by your local Personal Server when you approve."
  }
  const hours = seconds / 60 / 60
  if (Number.isInteger(hours)) {
    return ` It expires ${hours} ${hours === 1 ? "hour" : "hours"} after approval.`
  }
  return ` It expires ${Math.ceil(seconds / 60)} minutes after approval.`
}

function TimelineRevoked() {
  return <TimelineStatus title="Timeline access has expired or been revoked." />
}

function TimelineError({ message }: { message: string }) {
  return <TimelineStatus title={message} />
}

function TimelineStatus({ title }: { title: string }) {
  return (
    <section aria-live="polite" className="space-y-1">
      <Text as="h2" intent="heading">
        {title}
      </Text>
      <Text as="p" intent="small" muted>
        No records are shown.
      </Text>
    </section>
  )
}

function TimelineReady({
  activeStreamId,
  onStreamChange,
  streams,
  timeline,
  visibleTimeline,
  onLoadMore,
  isLoadingMore,
  onRevokeAccess,
  revokeError,
}: {
  activeStreamId: string | null
  onStreamChange: (streamId: string | null) => void
  streams: readonly { id: string; label: string }[]
  timeline: {
    processedRecordCount: number
    isTruncated: boolean
  }
  visibleTimeline: {
    dayGroups: readonly {
      dayKey: string
      events: readonly TimelineEvent[]
    }[]
    undatedRecords: readonly TimelineUndatedRecord[]
    processedRecordCount: number
  }
  onLoadMore?: () => void
  isLoadingMore: boolean
  onRevokeAccess?: () => void
  revokeError: string | null
}) {
  const hasRecords = visibleTimeline.processedRecordCount > 0

  return (
    <div className="space-y-w8">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div className="space-y-1">
          <Text as="p" intent="heading">
            {activeStreamId
              ? `${visibleTimeline.processedRecordCount} matching records`
              : `${timeline.processedRecordCount} records loaded`}
          </Text>
          <Text as="p" intent="small" muted>
            {activeStreamId
              ? `Filtered from ${timeline.processedRecordCount} loaded records.`
              : timeline.isTruncated
                ? "Additional records are available from your local Personal Server."
                : "All available records are loaded."}
          </Text>
        </div>
        <div className="space-y-1">
          <Text as="span" intent="fine" muted>
            Stream
          </Text>
          <Select
            value={activeStreamId ?? "all"}
            onValueChange={value =>
              onStreamChange(value === "all" ? null : value)
            }
          >
            <SelectTrigger aria-label="Filter timeline by stream">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All streams</SelectItem>
              {streams.map(stream => (
                <SelectItem key={stream.id} value={stream.id}>
                  {stream.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {timeline.isTruncated && onLoadMore ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onLoadMore} disabled={isLoadingMore}>
            {isLoadingMore ? (
              <>
                <Spinner />
                Loading more
              </>
            ) : (
              "Load more"
            )}
          </Button>
          <Text as="p" intent="small" muted>
            Loads the next {TIMELINE_MAX_RECORDS} records while keeping this
            filter.
          </Text>
        </div>
      ) : null}

      {hasRecords ? (
        <div className="space-y-w8">
          {visibleTimeline.dayGroups.map(group => (
            <TimelineDayGroup key={group.dayKey} {...group} />
          ))}
          {visibleTimeline.undatedRecords.length > 0 ? (
            <TimelineUndatedGroup records={visibleTimeline.undatedRecords} />
          ) : null}
        </div>
      ) : (
        <TimelineStatus title="No loaded records match this stream." />
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        {onRevokeAccess ? (
          <Button variant="outline" onClick={onRevokeAccess}>
            Revoke Timeline access
          </Button>
        ) : null}
        <Text as="p" intent="small" muted>
          Revokes this local Timeline approval and returns to the consent
          screen.
        </Text>
      </div>
      {revokeError ? (
        <Text as="p" intent="small" color="destructive">
          {revokeError}
        </Text>
      ) : null}
    </div>
  )
}

function TimelineDayGroup({
  dayKey,
  events,
}: {
  dayKey: string
  events: readonly TimelineEvent[]
}) {
  return (
    <section className="space-y-3">
      <Text as="h2" intent="heading">
        {dayKey}
      </Text>
      <ol className="divide-y divide-border border-y border-border">
        {events.map(event => (
          <li key={`${event.streamId}:${event.recordId}`} className="py-3">
            <Text as="p" intent="small">
              {event.label}
            </Text>
            <Text as="p" intent="fine" muted>
              {event.streamLabel} · {formatTime(event.timestampMs)}
            </Text>
          </li>
        ))}
      </ol>
    </section>
  )
}

function TimelineUndatedGroup({
  records,
}: {
  records: readonly TimelineUndatedRecord[]
}) {
  return (
    <section className="space-y-3">
      <Text as="h2" intent="heading">
        No usable date
      </Text>
      <Text as="p" intent="small" muted>
        These records are included, but their source did not provide a usable
        date.
      </Text>
      <ol className="divide-y divide-border border-y border-border">
        {records.map(record => (
          <li key={`${record.streamId}:${record.recordId}`} className="py-3">
            <Text as="p" intent="small">
              {record.label}
            </Text>
            <Text as="p" intent="fine" muted>
              {record.streamLabel}
            </Text>
          </li>
        ))}
      </ol>
    </section>
  )
}

function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(timestampMs)
}
