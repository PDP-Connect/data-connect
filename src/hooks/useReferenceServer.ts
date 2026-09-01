// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export type ReferenceServerLifecycle =
  | "idle"
  | "starting"
  | "signing-in"
  | "ready"
  | "error"
  | "crashed"

interface ReferenceServerStatus {
  running: boolean
  origin: string | null
  managed: boolean
}

const isTauriRuntime = () =>
  typeof window !== "undefined" &&
  ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)

/**
 * Owns the lifecycle of the embedded "Server & Repairs" reference server:
 * spawn/attach (start_reference_server), owner-session login
 * (login_reference_server), and the embedded child webview
 * (open/resize/hide_reference_server_view). One instance per mounted page —
 * unlike usePersonalServer this is not app-wide, since the reference server
 * is opt-in surface, not something the whole app depends on at boot.
 */
export function useReferenceServer(containerRef: React.RefObject<HTMLElement | null>) {
  const [lifecycle, setLifecycle] = useState<ReferenceServerLifecycle>("idle")
  const [error, setError] = useState<string | null>(null)
  const [origin, setOrigin] = useState<string | null>(null)
  const viewOpenedRef = useRef(false)

  const positionView = useCallback(() => {
    const el = containerRef.current
    if (!el || !viewOpenedRef.current) return
    const rect = el.getBoundingClientRect()
    void invoke("resize_reference_server_view", {
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    })
  }, [containerRef])

  const openView = useCallback(
    async (viewOrigin: string, sessionCookie: string) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      await invoke("open_reference_server_view", {
        origin: viewOrigin,
        sessionCookie,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      })
      viewOpenedRef.current = true
    },
    [containerRef]
  )

  const connect = useCallback(async () => {
    if (!isTauriRuntime()) {
      setError("Server & Repairs requires the desktop app runtime")
      setLifecycle("error")
      return
    }
    setError(null)
    setLifecycle("starting")
    try {
      const status = await invoke<ReferenceServerStatus>("start_reference_server")
      if (!status.origin) {
        throw new Error("Reference server started without reporting an origin")
      }
      setOrigin(status.origin)
      setLifecycle("signing-in")
      const login = await invoke<{ sessionCookie: string; origin: string }>(
        "login_reference_server",
        { origin: status.origin }
      )
      await openView(login.origin, login.sessionCookie)
      setLifecycle("ready")
    } catch (err) {
      console.error("[ReferenceServer] Failed to connect:", err)
      setError(err instanceof Error ? err.message : String(err))
      setLifecycle("error")
    }
  }, [openView])

  useEffect(() => {
    void connect()
    return () => {
      viewOpenedRef.current = false
      void invoke("hide_reference_server_view")
    }
    // Intentionally run once per mount — retry is user-initiated via `connect`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return
    const unlisteners: Array<() => void> = []
    listen<{ message: string }>("reference-server-error", event => {
      setError(event.payload.message)
      setLifecycle("error")
    }).then(fn => unlisteners.push(fn))
    listen("reference-server-crashed", () => {
      setLifecycle("crashed")
    }).then(fn => unlisteners.push(fn))
    listen<{ message: string }>("reference-server-restart-failed", event => {
      setError(event.payload.message)
      setLifecycle("error")
    }).then(fn => unlisteners.push(fn))
    return () => unlisteners.forEach(fn => fn())
  }, [])

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(positionView)
    observer.observe(el)
    window.addEventListener("resize", positionView)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", positionView)
    }
  }, [containerRef, positionView])

  return { lifecycle, error, origin, retry: connect }
}
