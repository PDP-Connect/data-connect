"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react"
import { cn } from "@/lib/utils.ts"
import { LiveReadAt, useLiveMutation, useLiveQuery } from "../components/live-provider.tsx"
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
 *
 * Both values are live topics (`components/live-provider.tsx`): a change in
 * another tab or on another device shows here within about a second. A
 * launch-at-login request shows "Applying…" until the desktop app records
 * the OS result, in this tab and in every other one.
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

function asAutostartPending(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  return (value as Partial<AutostartState>).pending === true
}

type LoadState = "loading" | "loaded" | "failed"

// A failed refetch keeps the last read on screen; only a read that never
// succeeded counts as failed.
function loadStateOf(...queries: Array<{ data: unknown; isError: boolean }>): LoadState {
  if (queries.every(query => query.data !== undefined)) return "loaded"
  return queries.some(query => query.isError) ? "failed" : "loading"
}

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

  // Nothing below is real state until both reads succeed. Until then we
  // must not paint a guessed value as the current setting — the same
  // discipline remote-access-setting.tsx applies, because rendering an
  // unverified "off" reads as a real answer to a user deciding whether to
  // trust their machine to a launch-at-login toggle.
  const autostart = useLiveQuery("desktop.autostart", loadAutostart)
  const appConfig = useLiveQuery("desktop.app-config", loadAppConfig)
  const loadState = loadStateOf(autostart, appConfig)
  const [error, setError] = useState<string | null>(null)
  const loadError = autostart.error ?? appConfig.error

  const autostartMutation = useLiveMutation("desktop.autostart", changeAutostart)
  // Read-modify-write of the whole config document, as before; each toggle
  // has its own mutation so each has its own busy state.
  const saveAppConfigField = async (patch: Partial<AppConfig>) =>
    saveAppConfig({ ...(await loadAppConfig()), ...patch })
  const startMinimizedMutation = useLiveMutation("desktop.app-config", (next: boolean) =>
    saveAppConfigField({ startMinimized: next })
  )
  const closeToTrayMutation = useLiveMutation("desktop.app-config", (next: boolean) =>
    saveAppConfigField({ closeToTray: next })
  )

  const stateIsKnown = loadState === "loaded"
  const desktopUnavailable = !stateIsKnown
  const autostartEnabled = asAutostartEnabled(autostart.data)
  const startMinimized = asStartMinimized(appConfig.data)
  const closeToTray = asCloseToTray(appConfig.data)
  // Applying: this tab's request is in flight, or the server reports a
  // request (from any tab or device) the desktop app has not applied yet.
  // Only this tab's own request disables the toggle: if the desktop app is
  // not running, a request can stay pending, and the owner must be able to
  // retry.
  const autostartApplying = autostartMutation.isPending || asAutostartPending(autostart.data)
  const busyStartMinimized = startMinimizedMutation.isPending
  const busyCloseToTray = closeToTrayMutation.isPending

  const reportResult = {
    onError: (reason: unknown) => setError(String(reason)),
    onSuccess: (result: { ok: true } | { ok: false; message: string }) => {
      if (!result.ok) setError(result.message)
    },
  }

  const toggleAutostart = (next: boolean) => {
    setError(null)
    autostartMutation.mutate(next, reportResult)
  }

  const toggleStartMinimized = (next: boolean) => {
    setError(null)
    startMinimizedMutation.mutate(next, reportResult)
  }

  const toggleCloseToTray = (next: boolean) => {
    setError(null)
    closeToTrayMutation.mutate(next, reportResult)
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
      {loadError && !error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {String(loadError)}
        </p>
      ) : null}
      <LiveReadAt updatedAt={Math.min(autostart.dataUpdatedAt, appConfig.dataUpdatedAt)} />

      <div
        className={cn(
          "grid gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-3",
          desktopUnavailable && "opacity-60"
        )}
      >
        <label className="flex items-start gap-2" htmlFor="autostart-enabled">
          <input
            checked={stateIsKnown && autostartEnabled}
            disabled={autostartMutation.isPending || desktopUnavailable}
            id="autostart-enabled"
            onChange={event => toggleAutostart(event.currentTarget.checked)}
            type="checkbox"
          />
          <span className="grid gap-1">
            <span className="pdpp-caption font-medium text-foreground">
              Launch at login
              {stateIsKnown && autostartApplying ? (
                <span
                  className="ml-2 font-normal text-muted-foreground"
                  data-testid="autostart-applying"
                >
                  Applying…
                </span>
              ) : null}
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
