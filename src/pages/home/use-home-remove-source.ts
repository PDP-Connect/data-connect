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
import { getPlatformRegistryEntry } from "@/lib/platform/utils"
import { deleteExportedRun } from "@/lib/tauri-paths"
import { deleteRun, setConnectedPlatforms } from "@/state/store"
import type { Platform, RootState, Run } from "@/types"

const PDPP_NETWORK_RUNTIME = "pdpp-network"

export type RemoveSourceAction = "sign-out" | "remove"

/**
 * A browser-based installed PDPP connector keeps a saved browser session on
 * this computer, which `reset_installed_pdpp_browser_profile` deletes.
 */
export function canSignOutOfSource(platform: Platform): boolean {
  return (
    platform.runtime === PDPP_NETWORK_RUNTIME &&
    platform.requiresBrowser === true &&
    installedPdppConnectionId(platform) !== null
  )
}

function canonicalSourceId(platform: {
  id: string
  name?: string
  company?: string
}) {
  return getPlatformRegistryEntry(platform)?.id ?? platform.id
}

function runCanonicalSourceId(run: Run) {
  return canonicalSourceId({
    id: run.platformId,
    name: run.name,
    company: run.company,
  })
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
  const requestIdRef = useRef(0)

  const request = useCallback((target: Platform) => {
    const requestId = ++requestIdRef.current
    setPlatform(target)
    setPending(null)
    setError(null)
    setHasServerConnection(false)
    const connectorKey = referenceConnectorKey(target)
    if (!connectorKey) return
    invoke<boolean>("reference_server_has_connection", { connectorKey })
      .then(found => {
        if (requestIdRef.current === requestId) setHasServerConnection(found)
      })
      .catch(() => {
        // An unknown answer hides the link; it must never point at a 404.
      })
  }, [])

  const close = useCallback(() => {
    requestIdRef.current += 1
    setPlatform(null)
    setPending(null)
    setError(null)
    setHasServerConnection(false)
  }, [])

  const cancel = useCallback(() => {
    if (pending) return
    close()
  }, [close, pending])

  const signOutIfBrowserSource = useCallback(async (target: Platform) => {
    if (!canSignOutOfSource(target)) return
    await invoke("reset_installed_pdpp_browser_profile", {
      connectorId: target.id,
      connectionId: installedPdppConnectionId(target),
    })
  }, [])

  const signOut = useCallback(async () => {
    if (!platform || pending || !canSignOutOfSource(platform)) return
    setPending("sign-out")
    setError(null)
    try {
      await signOutIfBrowserSource(platform)
      close()
    } catch (err) {
      setError(errorMessage(err))
      setPending(null)
    }
  }, [close, pending, platform, signOutIfBrowserSource])

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

      const sourceId = canonicalSourceId(target)
      const sourceRuns = runs.filter(
        run =>
          run.status !== "running" &&
          run.status !== "pending" &&
          (run.platformId === target.id ||
            runCanonicalSourceId(run) === sourceId)
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
          entry => connected[entry.id] && canonicalSourceId(entry) === sourceId
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
    canSignOut: platform ? canSignOutOfSource(platform) : false,
    hasServerConnection,
    pending,
    error,
    signOut,
    removeLocalData,
    openServerRepairs,
  }
}

export type HomeRemoveSource = ReturnType<typeof useHomeRemoveSource>
