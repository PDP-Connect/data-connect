import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/elements/spinner"
import { PageContainer } from "@/components/elements/page-container"
import { PageHeading } from "@/components/typography/page-heading"
import { Text } from "@/components/typography/text"
import {
  createProductionTimelineDataSource,
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
  } = useTimelinePage(dataSource)
  const [consentError, setConsentError] = useState<string | null>(null)

  const approveConsent = async () => {
    if (!requestConsent) return
    setConsentError(null)
    try {
      await requestConsent()
    } catch (error) {
      setConsentError(
        error instanceof Error
          ? error.message
          : "Timeline consent could not be approved."
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
          <TimelineUnauthorized
            onApprove={requestConsent ? approveConsent : undefined}
            error={consentError}
          />
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
  onApprove,
  error,
}: {
  onApprove?: () => void
  error: string | null
}) {
  if (!onApprove)
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
      <Button onClick={onApprove}>Allow local Timeline access</Button>
      {error ? (
        <Text as="p" intent="small" color="destructive">
          {error}
        </Text>
      ) : null}
    </section>
  )
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
}) {
  const hasRecords = visibleTimeline.processedRecordCount > 0

  return (
    <div className="space-y-w8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Text as="p" intent="small" muted>
          {activeStreamId
            ? `Showing ${visibleTimeline.processedRecordCount} of ${timeline.processedRecordCount} loaded records`
            : `${timeline.processedRecordCount} records loaded`}
        </Text>
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

      {timeline.isTruncated ? (
        <Text as="p" intent="small" muted>
          More records are available. This timeline is showing a bounded sample.
        </Text>
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
