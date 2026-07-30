import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import type { LocalTimelineConsentRequest } from "@/services/pdppTimeline"

type TimelinePageState = { kind: "loading" } | TimelineReadResult

export function useTimelinePage(dataSource: TimelineDataSource) {
  const [state, setState] = useState<TimelinePageState>({ kind: "loading" })
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const loadMoreAttemptRef = useRef(0)
  const loadMoreControllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadMoreAttemptRef.current += 1
      loadMoreControllerRef.current?.abort()
      loadMoreControllerRef.current = null
    }
  }, [])

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
  }, [dataSource, readAttempt])

  const requestConsent = useCallback(async () => {
    if (!dataSource.requestConsent) return
    return dataSource.requestConsent()
  }, [dataSource])

  const approveConsent = useCallback(
    async (consent: LocalTimelineConsentRequest) => {
      if (!dataSource.approveConsent) return
      await dataSource.approveConsent(consent)
      setReadAttempt(attempt => attempt + 1)
    },
    [dataSource]
  )

  const loadMore = useCallback(async () => {
    if (
      !dataSource.loadMore ||
      state.kind !== "ready" ||
      loadMoreControllerRef.current
    ) {
      return
    }
    const controller = new AbortController()
    loadMoreControllerRef.current = controller
    const attempt = loadMoreAttemptRef.current + 1
    loadMoreAttemptRef.current = attempt
    setIsLoadingMore(true)
    try {
      const result = await dataSource.loadMore(state.read, {
        maxStreams: TIMELINE_MAX_STREAMS,
        maxRecords: TIMELINE_MAX_RECORDS,
        signal: controller.signal,
      })
      if (mountedRef.current && loadMoreAttemptRef.current === attempt) {
        setState(result)
      }
    } catch {
      if (mountedRef.current && loadMoreAttemptRef.current === attempt) {
        setState({
          kind: "error",
          code: "failed",
          message: "Timeline records could not be loaded.",
          retryable: true,
        })
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null
      }
      if (mountedRef.current && loadMoreAttemptRef.current === attempt) {
        setIsLoadingMore(false)
      }
    }
  }, [dataSource, state])

  const revokeConsent = useCallback(async () => {
    if (!dataSource.revokeConsent) return false
    loadMoreAttemptRef.current += 1
    loadMoreControllerRef.current?.abort()
    loadMoreControllerRef.current = null
    setIsLoadingMore(false)
    const revoked = await dataSource.revokeConsent()
    setState({ kind: "unauthorized" })
    setSelectedStreamId(null)
    return revoked
  }, [dataSource])

  const timeline = useMemo(() => {
    if (state.kind !== "ready") {
      return null
    }

    const loadedRecordCount = state.read.streams.reduce(
      (count, stream) => count + stream.records.length,
      0
    )

    return deriveTimeline(state.read, {
      maxRecords: Math.max(TIMELINE_MAX_RECORDS, loadedRecordCount),
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
    requestConsent: dataSource.requestConsent ? requestConsent : undefined,
    approveConsent: dataSource.approveConsent ? approveConsent : undefined,
    loadMore:
      dataSource.loadMore && state.kind === "ready" ? loadMore : undefined,
    isLoadingMore,
    revokeConsent: dataSource.revokeConsent ? revokeConsent : undefined,
  }
}
