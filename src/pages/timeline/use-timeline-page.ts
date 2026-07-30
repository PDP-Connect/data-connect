import { useEffect, useMemo, useState } from "react"
import {
  TIMELINE_MAX_RECORDS,
  TIMELINE_MAX_STREAMS,
  type TimelineDataSource,
  type TimelineReadResult,
} from "@/apps/timeline/timeline-data-source"
import {
  deriveTimeline,
  filterTimeline,
} from "@/apps/timeline/timeline-derivation"

type TimelinePageState = { kind: "loading" } | TimelineReadResult

export function useTimelinePage(dataSource: TimelineDataSource) {
  const [state, setState] = useState<TimelinePageState>({ kind: "loading" })
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let isCurrent = true

    setState({ kind: "loading" })
    void dataSource
      .read({
        maxStreams: TIMELINE_MAX_STREAMS,
        maxRecords: TIMELINE_MAX_RECORDS,
        signal: controller.signal,
      })
      .then(result => {
        if (isCurrent) {
          setState(result)
        }
      })
      .catch(() => {
        if (isCurrent) {
          setState({
            kind: "error",
            code: "failed",
            message: "Timeline records could not be loaded.",
            retryable: true,
          })
        }
      })

    return () => {
      isCurrent = false
      controller.abort()
    }
  }, [dataSource])

  const timeline = useMemo(() => {
    if (state.kind !== "ready") {
      return null
    }

    return deriveTimeline(state.read, {
      maxRecords: TIMELINE_MAX_RECORDS,
      maxStreams: TIMELINE_MAX_STREAMS,
    })
  }, [state])
  const streamIds = useMemo(() => {
    if (!timeline) {
      return new Set<string>()
    }

    return new Set(timeline.streams.map(stream => stream.id))
  }, [timeline])
  const activeStreamId =
    selectedStreamId && streamIds.has(selectedStreamId)
      ? selectedStreamId
      : null
  const visibleTimeline = useMemo(
    () => (timeline ? filterTimeline(timeline, activeStreamId) : null),
    [activeStreamId, timeline]
  )

  return {
    activeStreamId,
    setSelectedStreamId,
    state,
    timeline,
    visibleTimeline,
  }
}
