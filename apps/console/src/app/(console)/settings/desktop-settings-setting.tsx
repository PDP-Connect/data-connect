"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils.ts"

type NativeInvoke = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>

interface DesktopSettingsProps {
  invoke?: NativeInvoke
}

interface TauriWindow {
  __TAURI_INTERNALS__?: {
    invoke?: NativeInvoke
  }
}

function nativeInvoke(): NativeInvoke | null {
  if (typeof window === "undefined") return null
  const internals = (window as TauriWindow).__TAURI_INTERNALS__
  return typeof internals?.invoke === "function" ? internals.invoke : null
}

/** Mirrors the AppConfig shape from src-tauri/src/commands/file_ops.rs. */
interface AppConfigShape {
  startMinimized?: boolean
}

function asStartMinimized(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const candidate = value as AppConfigShape
  return candidate.startMinimized === true
}

type LoadState = "loading" | "loaded" | "bridge_absent" | "failed"

export function DesktopSettingsSetting({
  invoke: suppliedInvoke,
}: DesktopSettingsProps) {
  const invoke = suppliedInvoke ?? nativeInvoke()

  // Neither default below is real state we have read yet. Until a load
  // succeeds we must not paint a guessed value as the current setting — the
  // same discipline remote-access-setting.tsx applies, because rendering an
  // unverified "off" reads as a real answer to a user deciding whether to
  // trust their machine to a launch-at-login toggle.
  const [autostartEnabled, setAutostartEnabled] = useState(false)
  const [startMinimized, setStartMinimizedState] = useState(false)
  const [loadState, setLoadState] = useState<LoadState>(() =>
    invoke ? "loading" : "bridge_absent"
  )
  const [error, setError] = useState<string | null>(null)
  const [busyAutostart, setBusyAutostart] = useState(false)
  const [busyStartMinimized, setBusyStartMinimized] = useState(false)

  useEffect(() => {
    if (!invoke) {
      setLoadState("bridge_absent")
      return
    }

    let cancelled = false
    setLoadState("loading")
    void Promise.all([
      invoke("get_autostart_enabled"),
      invoke("get_app_config"),
    ])
      .then(([autostart, config]) => {
        if (cancelled) return
        setAutostartEnabled(autostart === true)
        setStartMinimizedState(asStartMinimized(config))
        setLoadState("loaded")
      })
      .catch(reason => {
        if (cancelled) return
        setError(String(reason))
        setLoadState("failed")
      })

    return () => {
      cancelled = true
    }
  }, [invoke])

  const stateIsKnown = loadState === "loaded"
  const desktopUnavailable = !stateIsKnown

  const toggleAutostart = (next: boolean) => {
    if (!invoke) return
    setError(null)
    setBusyAutostart(true)
    void invoke("set_autostart_enabled", { enabled: next })
      .then(() => setAutostartEnabled(next))
      .catch(reason => setError(String(reason)))
      .finally(() => setBusyAutostart(false))
  }

  const toggleStartMinimized = (next: boolean) => {
    if (!invoke) return
    setError(null)
    setBusyStartMinimized(true)
    void invoke("get_app_config")
      .then(config => {
        const current =
          config && typeof config === "object"
            ? (config as Record<string, unknown>)
            : {}
        return invoke("set_app_config", {
          config: { ...current, startMinimized: next },
        })
      })
      .then(() => setStartMinimizedState(next))
      .catch(reason => setError(String(reason)))
      .finally(() => setBusyStartMinimized(false))
  }

  return (
    <div className="grid gap-3">
      {loadState === "loading" ? (
        <p className="pdpp-caption rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-muted-foreground">
          Reading the current desktop settings…
        </p>
      ) : null}
      {loadState === "bridge_absent" ? (
        <p className="pdpp-caption rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-muted-foreground">
          Desktop settings are unavailable here. Open the DataConnect desktop
          app to view or change them.
        </p>
      ) : null}
      {loadState === "failed" ? (
        <p className="pdpp-caption rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-muted-foreground">
          The current desktop settings could not be read, so they are not
          shown. The controls below are unavailable rather than assumed off.
        </p>
      ) : null}

      <div
        className={cn(
          "grid gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-3",
          desktopUnavailable && "opacity-60"
        )}
      >
        <label className="flex items-start gap-2" htmlFor="autostart-enabled">
          <input
            checked={stateIsKnown && autostartEnabled}
            disabled={busyAutostart || desktopUnavailable}
            id="autostart-enabled"
            onChange={event => toggleAutostart(event.currentTarget.checked)}
            type="checkbox"
          />
          <span className="grid gap-1">
            <span className="pdpp-caption font-medium text-foreground">
              Launch at login
            </span>
            <span className="pdpp-caption text-muted-foreground">
              Start DataConnect automatically when you sign in to this
              computer. Off by default.
            </span>
          </span>
        </label>
      </div>

      <div
        className={cn(
          "grid gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-3",
          desktopUnavailable && "opacity-60"
        )}
      >
        <label
          className="flex items-start gap-2"
          htmlFor="start-minimized"
        >
          <input
            checked={stateIsKnown && startMinimized}
            disabled={busyStartMinimized || desktopUnavailable}
            id="start-minimized"
            onChange={event =>
              toggleStartMinimized(event.currentTarget.checked)
            }
            type="checkbox"
          />
          <span className="grid gap-1">
            <span className="pdpp-caption font-medium text-foreground">
              Start minimized
            </span>
            <span className="pdpp-caption text-muted-foreground">
              Keep the console window hidden at startup. DataConnect keeps
              running in the tray; open it from there. Off by default.
            </span>
          </span>
        </label>
      </div>

      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
