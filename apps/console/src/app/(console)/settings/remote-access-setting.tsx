"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils.ts"
import {
  offRemoteAccessConfig,
  privacyBadgeForPosture,
  validateUserSuppliedOrigin,
  type RemoteAccessConfig,
  type RemoteAccessInspection,
  type RemoteAccessPosture,
} from "./remote-access.ts"

type NativeInvoke = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>

interface RemoteAccessSettingProps {
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

function asConfig(value: unknown): RemoteAccessConfig {
  if (!value || typeof value !== "object") return offRemoteAccessConfig()
  const candidate = value as Partial<RemoteAccessConfig>
  if (
    candidate.posture !== "off" &&
    candidate.posture !== "my_devices_only" &&
    candidate.posture !== "public_url"
  ) {
    return offRemoteAccessConfig()
  }
  return {
    posture: candidate.posture,
    provider:
      candidate.provider === "user_supplied_origin" ? candidate.provider : null,
    fields: candidate.fields ?? offRemoteAccessConfig().fields,
  }
}

function asInspection(value: unknown): RemoteAccessInspection {
  if (!value || typeof value !== "object") {
    return {
      availability: "unavailable",
      authentication: "not_required",
      reason: "Remote access is only available in the DataConnect desktop app.",
    }
  }
  const candidate = value as Partial<RemoteAccessInspection>
  return {
    availability:
      candidate.availability === "available" ? "available" : "unavailable",
    authentication:
      candidate.authentication === "required" ||
      candidate.authentication === "authenticated" ||
      candidate.authentication === "missing"
        ? candidate.authentication
        : "not_required",
    reason: typeof candidate.reason === "string" ? candidate.reason : null,
  }
}

const postureRows: Array<{
  posture: RemoteAccessPosture
  label: string
  description: string
}> = [
  {
    posture: "off",
    label: "Off",
    description: "Keep the Personal Server reachable from this device only.",
  },
  {
    posture: "my_devices_only",
    label: "My devices only",
    description:
      "Private device access. The secure embedded provider is not available yet.",
  },
  {
    posture: "public_url",
    label: "Public URL",
    description:
      "Use a proxy you control to reach this Personal Server from outside.",
  },
]

export function RemoteAccessSetting({
  invoke: suppliedInvoke,
}: RemoteAccessSettingProps) {
  const invoke = suppliedInvoke ?? nativeInvoke()
  const [config, setConfig] = useState<RemoteAccessConfig>(
    offRemoteAccessConfig
  )
  // The default config above is a placeholder, not state we have read. Until a
  // load succeeds, we must not paint it as the real posture: rendering "Off"
  // for an unknown state is what let the dishonest badge go unnoticed.
  const [loadState, setLoadState] = useState<
    "loading" | "loaded" | "bridge_absent" | "failed"
  >(() => (invoke ? "loading" : "bridge_absent"))
  const [inspection, setInspection] = useState<RemoteAccessInspection | null>(
    null
  )
  const [pendingPosture, setPendingPosture] =
    useState<RemoteAccessPosture | null>(null)
  const [origin, setOrigin] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!invoke) {
      setInspection(asInspection(null))
      setLoadState("bridge_absent")
      return
    }

    let cancelled = false
    setLoadState("loading")
    void Promise.all([
      invoke("get_remote_access_config"),
      invoke("inspect_remote_access"),
    ])
      .then(([nextConfig, nextInspection]) => {
        if (cancelled) return
        const resolved = asConfig(nextConfig)
        setConfig(resolved)
        setInspection(asInspection(nextInspection))
        setOrigin(resolved.fields.PDPP_REFERENCE_ORIGIN ?? "")
        setLoadState("loaded")
      })
      .catch(reason => {
        if (cancelled) return
        // The command exists but this build could not answer it. Report the
        // failure instead of falling back to a default that looks real.
        setError(String(reason))
        setLoadState("failed")
      })

    return () => {
      cancelled = true
    }
  }, [invoke])

  const stateIsKnown = loadState === "loaded"
  const desktopUnavailable = !stateIsKnown || inspection?.availability === "unavailable"
  const activeOrigin = config.fields.PDPP_REFERENCE_ORIGIN
  const configuredOriginValidation = useMemo(
    () => validateUserSuppliedOrigin(origin),
    [origin]
  )

  const choosePosture = (nextPosture: RemoteAccessPosture) => {
    setError(null)
    if (nextPosture === "off") {
      if (!invoke) return
      setBusy(true)
      void invoke("set_remote_access_config", {
        config: offRemoteAccessConfig(),
      })
        .then(() => setConfig(offRemoteAccessConfig()))
        .catch(reason => setError(String(reason)))
        .finally(() => setBusy(false))
      return
    }
    if (nextPosture === "my_devices_only") return
    setPendingPosture(nextPosture)
    setPassword("")
    setOrigin(activeOrigin ?? "")
  }

  const cancelPasswordGate = () => {
    setPendingPosture(null)
    setPassword("")
    setError(null)
  }

  const enablePublicUrl = () => {
    if (!invoke) {
      setError(
        "Remote access is only available in the DataConnect desktop app."
      )
      return
    }
    if (password.trim().length < 8) {
      setError("Choose an owner password with at least 8 characters.")
      return
    }
    if (!configuredOriginValidation.ok) {
      setError(configuredOriginValidation.message)
      return
    }

    const nextConfig: RemoteAccessConfig = {
      posture: "public_url",
      provider: "user_supplied_origin",
      fields: configuredOriginValidation.fields,
    }
    setBusy(true)
    setError(null)
    void invoke("configure_remote_access", {
      config: nextConfig,
      ownerPassword: password,
    })
      .then(nextConfigValue => {
        setConfig(asConfig(nextConfigValue ?? nextConfig))
        setPendingPosture(null)
        setPassword("")
      })
      .catch(reason => setError(String(reason)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <p className="pdpp-caption text-muted-foreground">
          Choose how this Personal Server can be reached. Remote access keeps
          the server bound to 127.0.0.1 and requires an owner password.
        </p>
        {loadState === "loading" ? (
          <p className="pdpp-caption rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-muted-foreground">
            Reading the current remote access state…
          </p>
        ) : null}
        {loadState === "bridge_absent" ? (
          <p className="pdpp-caption rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-muted-foreground">
            Remote access is unavailable here. Open the DataConnect desktop app
            to view or change it.
          </p>
        ) : null}
        {loadState === "failed" ? (
          <p className="pdpp-caption rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-muted-foreground">
            The current remote access state could not be read, so it is not
            shown. The setting below is unavailable rather than assumed off.
          </p>
        ) : null}
        {loadState === "loaded" && inspection?.availability === "unavailable" ? (
          <p className="pdpp-caption rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-muted-foreground">
            {inspection?.reason ??
              "Remote access is only available in the DataConnect desktop app."}
          </p>
        ) : null}
      </div>

      <div
        aria-label="Remote access posture"
        className="grid gap-2"
        role="radiogroup"
      >
        {postureRows.map(row => {
          // No row is selected until a real config has been read.
          const selected = stateIsKnown && config.posture === row.posture
          const unavailable = row.posture === "my_devices_only"
          return (
            <label
              className={cn(
                "grid gap-2 rounded-md border px-3 py-3 transition-colors",
                selected
                  ? "border-foreground/50 bg-muted/30"
                  : "border-border/70",
                unavailable || desktopUnavailable
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer"
              )}
              key={row.posture}
            >
              <span className="flex items-start gap-3">
                <input
                  aria-label={row.label}
                  checked={selected}
                  disabled={busy || unavailable || desktopUnavailable}
                  name="remote-access-posture"
                  onChange={() => choosePosture(row.posture)}
                  type="radio"
                />
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="pdpp-caption font-medium text-foreground">
                      {row.label}
                    </span>
                    <span className="pdpp-caption rounded-full border border-border/80 px-2 py-0.5 text-muted-foreground">
                      {privacyBadgeForPosture(row.posture)}
                    </span>
                  </span>
                  <span className="pdpp-caption text-muted-foreground">
                    {row.description}
                  </span>
                </span>
              </span>
            </label>
          )
        })}
      </div>

      {stateIsKnown && config.posture === "public_url" ? (
        <div className="grid gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="pdpp-caption font-medium text-foreground">
              User-supplied origin
            </span>
            <span className="pdpp-caption rounded-full border border-border/80 px-2 py-0.5 text-muted-foreground">
              {privacyBadgeForPosture("public_url")}
            </span>
          </div>
          <p className="pdpp-caption text-muted-foreground">
            DataConnect does not operate this proxy and cannot verify how it
            handles TLS. Unless it passes TLS through to the loopback Personal
            Server, its operator can read your traffic in plaintext. Your proxy
            must forward the root origin to the loopback Personal Server.
          </p>
          <p className="break-all font-mono text-xs text-foreground/80">
            {activeOrigin}
          </p>
          <button
            className="justify-self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            disabled={busy || desktopUnavailable}
            onClick={() => choosePosture("public_url")}
            type="button"
          >
            Change origin
          </button>
        </div>
      ) : null}

      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {pendingPosture === "public_url" ? (
        <div
          aria-label="Set owner password"
          className="grid gap-3 rounded-md border border-foreground/20 bg-background px-3 py-3"
          role="dialog"
        >
          <div className="grid gap-1">
            <h3 className="pdpp-caption font-semibold text-foreground">
              Set an owner password
            </h3>
            <p className="pdpp-caption text-muted-foreground">
              Remote access cannot turn on without a password you choose. This
              blocks owner controls from an unprotected public origin.
            </p>
          </div>
          <label
            className="grid gap-1 pdpp-caption text-foreground"
            htmlFor="remote-access-password"
          >
            Owner password
            <input
              autoComplete="new-password"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              id="remote-access-password"
              minLength={8}
              onChange={event => setPassword(event.currentTarget.value)}
              type="password"
              value={password}
            />
          </label>
          <label
            className="grid gap-1 pdpp-caption text-foreground"
            htmlFor="remote-access-origin"
          >
            HTTPS origin
            <input
              autoCapitalize="none"
              autoComplete="url"
              className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              id="remote-access-origin"
              onChange={event => setOrigin(event.currentTarget.value)}
              placeholder="https://vault.example.com"
              spellCheck={false}
              type="url"
              value={origin}
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              disabled={busy}
              onClick={cancelPasswordGate}
              type="button"
            >
              Cancel
            </button>
            <button
              className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90 disabled:opacity-50"
              disabled={busy}
              onClick={enablePublicUrl}
              type="button"
            >
              {busy ? "Enabling…" : "Set password and enable"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
