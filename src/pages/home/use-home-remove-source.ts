// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useDispatch, useSelector } from "react-redux"
import { useNavigate } from "react-router-dom"
import { installedPdppConnectionId } from "@/hooks/useConnector"
import {
  consoleDangerZonePath,
  referenceConnectorKey,
  serverRepairsHref,
} from "@/lib/platform/console-source-path"
import { getPlatformRegistryEntryById } from "@/lib/platform/utils"
import { deleteExportedRun } from "@/lib/tauri-paths"
import { deleteRun, setConnectedPlatforms } from "@/state/store"
import type { Platform, RootState } from "@/types"

const PDPP_NETWORK_RUNTIME = "pdpp-network"
const PLAYWRIGHT_RUNTIME = "playwright-runtime"

export type RemoveSourceAction = "sign-out" | "remove"

/**
 * A source has a saved session when its installed PDPP profile is available or
 * a matching legacy Playwright profile exists on this computer.
 */
export function canSignOutOfSource(
  platform: Platform,
  hasLegacyBrowserSession = false
): boolean {
  return (
    (platform.runtime === PDPP_NETWORK_RUNTIME &&
      platform.requiresBrowser === true &&
      installedPdppConnectionId(platform) !== null) ||
    hasLegacyBrowserSession
  )
}

function sourcePlatformIds(platform: Platform): Set<string> {
  return new Set([
    platform.id,
    ...(getPlatformRegistryEntryById(platform.id)?.platformIds ?? []),
  ])
}

function sourcePlatforms(
  platform: Platform,
  platforms: Platform[]
): Platform[] {
  const ids = sourcePlatformIds(platform)
  return [platform, ...platforms.filter(entry => ids.has(entry.id))].filter(
    (entry, index, entries) =>
      entries.findIndex(candidate => candidate.id === entry.id) === index
  )
}

function hasLegacyBrowserSession(
  target: Platform,
  platforms: Platform[],
  browserSessionIds: string[]
): boolean {
  return sourcePlatforms(target, platforms).some(
    entry =>
      entry.runtime === PLAYWRIGHT_RUNTIME &&
      browserSessionIds.includes(entry.filename)
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Remove-source dialog state and its side effects. Every action works on
 * desktop-local state: the saved browser session, the exported data, the
 * PDPP collection state and the run history. Server copies are managed in
 * Server & Repairs, which is linked only when the server holds a connection.
 */
export function useHomeRemoveSource() {
  const navigate = useNavigate()
  const dispatch = useDispatch()
  const runs = useSelector((state: RootState) => state.app.runs)
  const platforms = useSelector((state: RootState) => state.app.platforms)
  const [platform, setPlatform] = useState<Platform | null>(null)
  const [pending, setPending] = useState<RemoveSourceAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasServerConnection, setHasServerConnection] = useState(false)
  const [browserSessionIds, setBrowserSessionIds] = useState<string[]>([])
  const requestIdRef = useRef(0)

  const request = useCallback((target: Platform) => {
    const requestId = ++requestIdRef.current
    setPlatform(target)
    setPending(null)
    setError(null)
    setHasServerConnection(false)
    setBrowserSessionIds([])
    const connectorKey = referenceConnectorKey(target)
    if (connectorKey) {
      invoke<boolean>("reference_server_has_connection", { connectorKey })
        .then(found => {
          if (requestIdRef.current === requestId) setHasServerConnection(found)
        })
        .catch(() => {
          // An unknown answer hides the link; it must never point at a 404.
        })
    }
    invoke<Array<{ connectorId: string }>>("list_browser_sessions")
      .then(sessions => {
        if (requestIdRef.current === requestId) {
          setBrowserSessionIds(sessions.map(session => session.connectorId))
        }
      })
      .catch(() => {
        if (requestIdRef.current === requestId) setBrowserSessionIds([])
      })
  }, [])

  const close = useCallback(() => {
    requestIdRef.current += 1
    setPlatform(null)
    setPending(null)
    setError(null)
    setHasServerConnection(false)
    setBrowserSessionIds([])
  }, [])

  const cancel = useCallback(() => {
    if (pending) return
    close()
  }, [close, pending])

  const signOutIfBrowserSource = useCallback(
    async (target: Platform) => {
      if (
        target.runtime === PDPP_NETWORK_RUNTIME &&
        target.requiresBrowser === true &&
        installedPdppConnectionId(target) !== null
      ) {
        await invoke("reset_installed_pdpp_browser_profile", {
          connectorId: target.id,
          connectionId: installedPdppConnectionId(target),
        })
      }
      for (const sourcePlatform of sourcePlatforms(target, platforms)) {
        if (sourcePlatform.runtime === PLAYWRIGHT_RUNTIME) {
          await invoke("clear_browser_session", {
            connectorId: sourcePlatform.filename,
          })
        }
      }
    },
    [platforms]
  )

  const signOut = useCallback(async () => {
    if (
      !platform ||
      pending ||
      !canSignOutOfSource(
        platform,
        hasLegacyBrowserSession(platform, platforms, browserSessionIds)
      )
    )
      return
    setPending("sign-out")
    setError(null)
    try {
      await signOutIfBrowserSource(platform)
      close()
    } catch (err) {
      setError(errorMessage(err))
      setPending(null)
    }
  }, [
    browserSessionIds,
    close,
    pending,
    platform,
    platforms,
    signOutIfBrowserSource,
  ])

  const removeLocalData = useCallback(async () => {
    if (!platform || pending) return
    const target = platform
    setPending("remove")
    setError(null)
    try {
      // Sign out first: the native side refuses while a run holds the
      // browser session, and then nothing else is touched.
      await signOutIfBrowserSource(target)
      if (target.runtime === PDPP_NETWORK_RUNTIME) {
        await invoke("clear_pdpp_collection_state", { connectorId: target.id })
      }

      const targetPlatformIds = sourcePlatformIds(target)
      const sourceRuns = runs.filter(
        run =>
          run.status !== "running" &&
          run.status !== "pending" &&
          targetPlatformIds.has(run.platformId)
      )
      for (const run of sourceRuns) {
        if (run.exportPath) await deleteExportedRun(run.exportPath)
        dispatch(deleteRun(run.id))
      }

      const platformIds = platforms.map(entry => entry.id)
      if (platformIds.length > 0) {
        const connected = await invoke<Record<string, boolean>>(
          "check_connected_platforms",
          { platformIds }
        )
        dispatch(setConnectedPlatforms(connected))
        const stillConnected = platforms.some(
          entry => connected[entry.id] && targetPlatformIds.has(entry.id)
        )
        if (stillConnected) {
          setError(
            `Some saved files for ${target.name} are still on this computer, so it still shows in this list.`
          )
          setPending(null)
          return
        }
      }
      close()
    } catch (err) {
      setError(errorMessage(err))
      setPending(null)
    }
  }, [
    close,
    dispatch,
    pending,
    platform,
    platforms,
    runs,
    signOutIfBrowserSource,
  ])

  const openServerRepairs = useCallback(() => {
    if (!platform || !hasServerConnection) return
    const path = consoleDangerZonePath(platform)
    close()
    navigate(serverRepairsHref(path))
  }, [close, hasServerConnection, navigate, platform])

  return {
    platform,
    request,
    cancel,
    canSignOut: platform
      ? canSignOutOfSource(
          platform,
          hasLegacyBrowserSession(platform, platforms, browserSessionIds)
        )
      : false,
    hasServerConnection,
    pending,
    error,
    signOut,
    removeLocalData,
    openServerRepairs,
  }
}

export type HomeRemoveSource = ReturnType<typeof useHomeRemoveSource>
