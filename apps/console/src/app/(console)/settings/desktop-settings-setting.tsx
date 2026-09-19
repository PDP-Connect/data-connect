"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils.ts"
import type { AppConfig } from "../lib/app-config-client.ts"
import type { AutostartState } from "../lib/autostart-client.ts"
import {
  loadAppConfigAction,
  loadAutostartAction,
  saveAppConfigAction,
  setAutostartAction,
} from "./desktop-settings-actions.ts"

/**
 * Both the generic app-config blob (start-minimized/close-to-tray) and
 * autostart now run over owner-authenticated HTTP routes on the reference
 * server (see `desktop-settings-actions.ts`), in both the desktop app and a
 * plain browser -- the same shape `remote-access-setting.tsx` established
 * for the `user_supplied_origin` remote-access provider. Unlike remote
 * access's ngrok path, this component makes no Tauri IPC calls at all:
 * neither surface here needs the OS keychain or Rust-side process
 * supervision from the console's perspective (autostart's OS side effect is
 * applied asynchronously by `unified.rs::spawn_autostart_watcher`, not by
 * this window).
 */
interface DesktopSettingsProps {
  loadAppConfig?: typeof loadAppConfigAction
  saveAppConfig?: typeof saveAppConfigAction
  loadAutostart?: typeof loadAutostartAction
  setAutostart?: typeof setAutostartAction
}

function asStartMinimized(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<AppConfig>
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
  const candidate = value as Partial<AppConfig>
  return candidate.closeToTray !== false
}

function asAutostartEnabled(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<AutostartState>
  return candidate.enabled === true
}

type LoadState = "loading" | "loaded" | "failed"

export function DesktopSettingsSetting({
  loadAppConfig: suppliedLoadAppConfig,
  saveAppConfig: suppliedSaveAppConfig,
  loadAutostart: suppliedLoadAutostart,
  setAutostart: suppliedSetAutostart,
}: DesktopSettingsProps) {
  const loadAppConfig = suppliedLoadAppConfig ?? loadAppConfigAction
  const saveAppConfig = suppliedSaveAppConfig ?? saveAppConfigAction
  const loadAutostart = suppliedLoadAutostart ?? loadAutostartAction
  const changeAutostart = suppliedSetAutostart ?? setAutostartAction

  // Neither default below is real state we have read yet. Until a load
  // succeeds we must not paint a guessed value as the current setting — the
  // same discipline remote-access-setting.tsx applies, because rendering an
  // unverified "off" reads as a real answer to a user deciding whether to
  // trust their machine to a launch-at-login toggle.
  const [autostartEnabled, setAutostartEnabledState] = useState(false)
  const [startMinimized, setStartMinimizedState] = useState(false)
  const [closeToTray, setCloseToTrayState] = useState(true)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [error, setError] = useState<string | null>(null)
  const [busyAutostart, setBusyAutostart] = useState(false)
  const [busyStartMinimized, setBusyStartMinimized] = useState(false)
  const [busyCloseToTray, setBusyCloseToTray] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoadState("loading")
    void Promise.all([loadAutostart(), loadAppConfig()])
      .then(([autostart, config]) => {
        if (cancelled) return
        setAutostartEnabledState(asAutostartEnabled(autostart))
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
  }, [loadAutostart, loadAppConfig])

  const stateIsKnown = loadState === "loaded"
  const desktopUnavailable = !stateIsKnown

  const toggleAutostart = (next: boolean) => {
    setError(null)
    setBusyAutostart(true)
    void changeAutostart(next)
      .then(result => {
        if (!result.ok) {
          setError(result.message)
          return
        }
        setAutostartEnabledState(result.enabled)
      })
      .catch(reason => setError(String(reason)))
      .finally(() => setBusyAutostart(false))
  }

  const toggleStartMinimized = (next: boolean) => {
    setError(null)
    setBusyStartMinimized(true)
    void loadAppConfig()
      .then(current => saveAppConfig({ ...current, startMinimized: next }))
      .then(result => {
        if (!result.ok) {
          setError(result.message)
          return
        }
        setStartMinimizedState(next)
      })
      .catch(reason => setError(String(reason)))
      .finally(() => setBusyStartMinimized(false))
  }

  const toggleCloseToTray = (next: boolean) => {
    setError(null)
    setBusyCloseToTray(true)
    void loadAppConfig()
      .then(current => saveAppConfig({ ...current, closeToTray: next }))
      .then(result => {
        if (!result.ok) {
          setError(result.message)
          return
        }
        setCloseToTrayState(next)
      })
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
