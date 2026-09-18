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
  closeToTray?: boolean
}

function asStartMinimized(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const candidate = value as AppConfigShape
  return candidate.startMinimized === true
}

// AppConfig::default() on the Rust side defaults closeToTray to true, and
// this must read the same way here: an unset/unrecognized value should not
// display as "off" while the backend actually treats it as "on". Unlike
// asStartMinimized (whose real default is false), the absence of a value
// -- an unread state, not a confirmed false -- must not paint as false, so
// this only returns false for an explicit `false`, not for undefined/missing.
function asCloseToTray(value: unknown): boolean {
  if (!value || typeof value !== "object") return true
  const candidate = value as AppConfigShape
  return candidate.closeToTray !== false
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
  const [closeToTray, setCloseToTrayState] = useState(true)
  const [loadState, setLoadState] = useState<LoadState>(() =>
    invoke ? "loading" : "bridge_absent"
  )
  const [error, setError] = useState<string | null>(null)
  const [busyAutostart, setBusyAutostart] = useState(false)
  const [busyStartMinimized, setBusyStartMinimized] = useState(false)
  const [busyCloseToTray, setBusyCloseToTray] = useState(false)

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
        setCloseToTrayState(asCloseToTray(config))
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

  const toggleCloseToTray = (next: boolean) => {
    if (!invoke) return
    setError(null)
    setBusyCloseToTray(true)
    void invoke("get_app_config")
      .then(config => {
        const current =
          config && typeof config === "object"
            ? (config as Record<string, unknown>)
            : {}
        return invoke("set_app_config", {
          config: { ...current, closeToTray: next },
        })
      })
      .then(() => setCloseToTrayState(next))
      .catch(reason => setError(String(reason)))
      .finally(() => setBusyCloseToTray(false))
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

      <div
        className={cn(
          "grid gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-3",
          desktopUnavailable && "opacity-60"
        )}
      >
        <label className="flex items-start gap-2" htmlFor="close-to-tray">
          <input
            checked={stateIsKnown && closeToTray}
            disabled={busyCloseToTray || desktopUnavailable}
            id="close-to-tray"
            onChange={event => toggleCloseToTray(event.currentTarget.checked)}
            type="checkbox"
          />
          <span className="grid gap-1">
            <span className="pdpp-caption font-medium text-foreground">
              Keep running when the window is closed
            </span>
            <span className="pdpp-caption text-muted-foreground">
              Closing the window hides it to the tray instead of quitting.
              DataConnect and its background connectors keep running; quit
              from the tray menu to stop them. On by default.
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
