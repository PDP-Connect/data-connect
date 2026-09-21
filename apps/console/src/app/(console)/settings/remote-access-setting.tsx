"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react"
import { OpenExternalLink } from "@/app/(console)/components/open-external-link.tsx"
import { cn } from "@/lib/utils.ts"
import {
  loadRemoteAccessStateAction,
  setRemoteAccessConfigAction,
} from "./remote-access-actions.ts"
import {
  DEFAULT_PUBLIC_URL_OPTION_ID,
  ngrokDurableAddressState,
  offRemoteAccessConfig,
  privacyBadgeForPosture,
  publicUrlOptionById,
  publicUrlOptions,
  remoteAccessOriginDisplay,
  validateCloudflareTunnelHostname,
  validateNgrokDomain,
  validatePinnedConsolePort,
  validateUserSuppliedOrigin,
  type PublicUrlOption,
  type RemoteAccessConfig,
  type RemoteAccessInspection,
  type RemoteAccessPosture,
} from "./remote-access.ts"

/**
 * Both providers' config surfaces (load/save) run over the owner-
 * authenticated HTTP routes on the reference server -- see
 * `remote-access-actions.ts` -- in both the desktop app and a plain browser.
 * Tauri's `invoke()` bridge is never used here: it does not exist in the
 * console's `http://127.0.0.1:{port}` window regardless of provider (Tauri
 * Discussion #2650). ngrok's authtoken travels in the same HTTP POST as the
 * rest of its config (`providerCredential`); the reference server seals it
 * before persisting it, and only the Tauri host's own config-file watcher
 * ever decrypts it, into the OS keychain -- see `owner-remote-access.ts` and
 * `src-tauri/src/unified.rs::spawn_remote_access_config_watcher`. ngrok's
 * native tunnel supervision still requires that Tauri host to be present;
 * when it is not, `ngrokInspection` reports that honestly (see
 * `ngrokInspection`/`ngrokUnavailable` below) instead of accepting a config
 * that will never activate.
 */
interface RemoteAccessSettingProps {
  loadState?: typeof loadRemoteAccessStateAction
  saveConfig?: typeof setRemoteAccessConfigAction
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
      candidate.provider === "user_supplied_origin" ||
      candidate.provider === "ngrok" ||
      candidate.provider === "cloudflare_tunnel"
        ? candidate.provider
        : null,
    fields: candidate.fields ?? offRemoteAccessConfig().fields,
    console_port:
      typeof candidate.console_port === "number" ? candidate.console_port : null,
    ngrok: candidate.ngrok ?? null,
    cloudflare_tunnel: candidate.cloudflare_tunnel ?? null,
    tunnel_error:
      typeof candidate.tunnel_error === "string" ? candidate.tunnel_error : null,
  }
}

/** Recover which option row produced the stored config, for the active panel. */
function activeOption(config: RemoteAccessConfig): PublicUrlOption | null {
  if (config.provider === "user_supplied_origin") {
    return publicUrlOptionById("user_supplied_origin")
  }
  if (config.provider === "cloudflare_tunnel") {
    return publicUrlOptionById("cloudflare_tunnel")
  }
  if (config.provider === "ngrok" && config.ngrok) {
    return (
      publicUrlOptions.find(
        option => option.ngrokMode === config.ngrok?.endpoint_mode
      ) ?? null
    )
  }
  return null
}

function asInspection(value: unknown): RemoteAccessInspection {
  if (!value || typeof value !== "object") {
    return {
      availability: "unavailable",
      authentication: "not_required",
      reason: "The current remote access state could not be read.",
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
  loadState: suppliedLoadState,
  saveConfig: suppliedSaveConfig,
}: RemoteAccessSettingProps) {
  const loadRemoteAccessState = suppliedLoadState ?? loadRemoteAccessStateAction
  const saveRemoteAccessConfig = suppliedSaveConfig ?? setRemoteAccessConfigAction
  const [config, setConfig] = useState<RemoteAccessConfig>(
    offRemoteAccessConfig
  )
  // The default config above is a placeholder, not state we have read. Until a
  // load succeeds, we must not paint it as the real posture: rendering "Off"
  // for an unknown state is what let the dishonest badge go unnoticed.
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">(
    "loading"
  )
  const [inspection, setInspection] = useState<RemoteAccessInspection | null>(
    null
  )
  const [ngrokInspection, setNgrokInspection] =
    useState<RemoteAccessInspection | null>(null)
  const [cloudflareTunnelInspection, setCloudflareTunnelInspection] =
    useState<RemoteAccessInspection | null>(null)
  const [pendingPosture, setPendingPosture] =
    useState<RemoteAccessPosture | null>(null)
  const [origin, setOrigin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [optionId, setOptionId] = useState<string>(DEFAULT_PUBLIC_URL_OPTION_ID)
  const [authtoken, setAuthtoken] = useState("")
  const [ngrokDomain, setNgrokDomain] = useState("")
  const [pinnedPort, setPinnedPort] = useState("")
  // The port this console process is actually bound to right now (read
  // server-side from process.env.PORT), independent of any pin the owner
  // has saved. Shown so the owner's proxy config can match reality even
  // before -- or instead of -- setting a pin.
  const [effectiveConsolePort, setEffectiveConsolePort] = useState<
    number | null
  >(null)
  const [cloudflareToken, setCloudflareToken] = useState("")
  const [cloudflareHostname, setCloudflareHostname] = useState("")

  useEffect(() => {
    let cancelled = false
    setLoadState("loading")
    void loadRemoteAccessState()
      .then(
        ({
          config: nextConfig,
          effectiveConsolePort: nextPort,
          inspection: nextInspection,
          ngrokInspection: nextNgrokInspection,
          cloudflareTunnelInspection: nextCloudflareTunnelInspection,
        }) => {
          if (cancelled) return
          const resolved = asConfig(nextConfig)
          setConfig(resolved)
          setInspection(asInspection(nextInspection))
          setNgrokInspection(asInspection(nextNgrokInspection))
          setCloudflareTunnelInspection(asInspection(nextCloudflareTunnelInspection))
          setOrigin(resolved.fields.PDPP_REFERENCE_ORIGIN ?? "")
          // Without this, an owner who already saved their ngrok domain sees
          // a blank field on every page load and has no way to tell their
          // domain was remembered -- exactly the "silent fallback" the
          // durable-address states exist to prevent.
          setNgrokDomain(resolved.ngrok?.reserved_domain ?? "")
          setCloudflareHostname(resolved.cloudflare_tunnel?.hostname ?? "")
          setPinnedPort(
            resolved.console_port != null ? String(resolved.console_port) : ""
          )
          setEffectiveConsolePort(nextPort ?? null)
          setLoadState("loaded")
        }
      )
      .catch(reason => {
        if (cancelled) return
        // The route exists but this request could not answer it. Report the
        // failure instead of falling back to a default that looks real.
        setError(String(reason))
        setLoadState("failed")
      })

    return () => {
      cancelled = true
    }
  }, [loadRemoteAccessState])

  const stateIsKnown = loadState === "loaded"
  const desktopUnavailable = !stateIsKnown || inspection?.availability === "unavailable"
  // Specific to the ngrok row: user_supplied_origin can still work (via
  // `inspection` above) even when ngrok cannot (no Tauri host to supervise
  // its tunnel). Kept separate from `desktopUnavailable` so an ngrok-only
  // outage does not blank-disable the whole Public URL flow.
  const ngrokUnavailable = !stateIsKnown || ngrokInspection?.availability === "unavailable"
  // Same shape as `ngrokUnavailable`, for the Cloudflare tunnel row: it too
  // needs a native host (keychain + `cloudflared` process supervision) and
  // can be unavailable independent of the rest of the Public URL flow.
  const cloudflareTunnelUnavailable =
    !stateIsKnown || cloudflareTunnelInspection?.availability === "unavailable"
  const activeOrigin = config.fields.PDPP_REFERENCE_ORIGIN
  const configuredOriginValidation = useMemo(
    () => validateUserSuppliedOrigin(origin),
    [origin]
  )
  // Driven by the SAVED config, not the in-progress edit in `ngrokDomain` --
  // this tells the owner what is actually active right now, the same way
  // `activeOrigin` above reflects the saved origin rather than the draft.
  const ngrokDurableAddress = useMemo(
    () => ngrokDurableAddressState(config),
    [config]
  )
  const selectedOption = useMemo(
    () => publicUrlOptionById(optionId),
    [optionId]
  )
  const runningOption = useMemo(() => activeOption(config), [config])
  const originDisplay = useMemo(() => remoteAccessOriginDisplay(config), [config])

  const choosePosture = (nextPosture: RemoteAccessPosture) => {
    setError(null)
    if (nextPosture === "off") {
      setBusy(true)
      void saveRemoteAccessConfig(offRemoteAccessConfig())
        .then(result => {
          if (!result.ok) {
            setError(result.message)
            return
          }
          setConfig(asConfig(result.config))
        })
        .catch(reason => setError(String(reason)))
        .finally(() => setBusy(false))
      return
    }
    if (nextPosture === "my_devices_only") return
    setPendingPosture(nextPosture)
    setOrigin(activeOrigin ?? "")
  }

  const cancelPublicUrlDialog = () => {
    setPendingPosture(null)
    setError(null)
  }

  /**
   * Offered from the ERR_NGROK_312 guidance: reopens the Public URL dialog
   * pre-selected to ngrok HTTPS, the free-plan alternative. Does not submit
   * on its own -- the owner still needs to confirm (and re-paste the
   * authtoken, since `enablePublicUrl` never retains it after a save), same
   * as picking the row by hand.
   */
  const switchToNgrokHttps = () => {
    setError(null)
    setOptionId("ngrok_https_edge_termination")
    setPendingPosture("public_url")
  }

  /**
   * The owner is already authenticated to reach this page (an owner bearer
   * token cannot be minted without PDPP_OWNER_PASSWORD already configured),
   * so neither provider re-collects a password here -- there is no separate
   * credential to set for either. ngrok's authtoken is a provider credential,
   * not an owner credential; see the module doc comment above.
   */
  const enablePublicUrl = () => {
    const option = publicUrlOptionById(optionId)
    if (!option) {
      setError("Choose how this Personal Server should be reachable.")
      return
    }

    if (option.provider === "user_supplied_origin") {
      if (!configuredOriginValidation.ok) {
        setError(configuredOriginValidation.message)
        return
      }
      const portValidation = validatePinnedConsolePort(pinnedPort)
      if (!portValidation.ok) {
        setError(portValidation.message)
        return
      }
      const nextConfig: RemoteAccessConfig = {
        posture: "public_url",
        provider: "user_supplied_origin",
        fields: configuredOriginValidation.fields,
        console_port: portValidation.port,
      }
      setBusy(true)
      setError(null)
      void saveRemoteAccessConfig(nextConfig)
        .then(result => {
          if (!result.ok) {
            setError(result.message)
            return
          }
          setConfig(asConfig(result.config))
          setPendingPosture(null)
        })
        .catch(reason => setError(String(reason)))
        .finally(() => setBusy(false))
      return
    }

    if (option.provider === "cloudflare_tunnel") {
      if (cloudflareTunnelUnavailable) {
        setError(
          cloudflareTunnelInspection?.reason ??
            "Cloudflare Tunnel is only available in the DataConnect desktop app. Use \"A proxy you run\" here instead."
        )
        return
      }
      if (!cloudflareToken.trim()) {
        setError("Paste your Cloudflare tunnel token to continue.")
        return
      }
      const hostname = validateCloudflareTunnelHostname(cloudflareHostname)
      if (!hostname.ok) {
        setError(hostname.message)
        return
      }
      // The hostname is already the durable origin -- unlike ngrok, there is
      // no discovery step, but the four fields still stay empty here: the
      // Tauri supervisor's `start_cloudflare_tunnel_provider` is what fills
      // them in once the tunnel is confirmed to have actually started.
      const nextConfig: RemoteAccessConfig = {
        posture: "public_url",
        provider: "cloudflare_tunnel",
        fields: offRemoteAccessConfig().fields,
        cloudflare_tunnel: { hostname: hostname.hostname },
      }
      setBusy(true)
      setError(null)
      void saveRemoteAccessConfig(nextConfig, cloudflareToken.trim())
        .then(result => {
          if (!result.ok) {
            setError(result.message)
            return
          }
          setConfig(asConfig(result.config))
          setPendingPosture(null)
          // The token is now sealed at rest and only the desktop host's
          // config watcher can decrypt it; drop the copy here.
          setCloudflareToken("")
        })
        .catch(reason => setError(String(reason)))
        .finally(() => setBusy(false))
      return
    }

    if (ngrokUnavailable) {
      setError(
        ngrokInspection?.reason ??
          "ngrok is only available in the DataConnect desktop app. Use \"A proxy you run\" here instead."
      )
      return
    }
    if (!authtoken.trim()) {
      setError("Paste your ngrok authtoken to continue.")
      return
    }
    const domain = validateNgrokDomain(ngrokDomain)
    if (!domain.ok) {
      setError(domain.message)
      return
    }
    // ngrok is assigned its hostname by the edge at start, so the four
    // fields stay empty until the adapter reports the origin.
    const nextConfig: RemoteAccessConfig = {
      posture: "public_url",
      provider: "ngrok",
      fields: offRemoteAccessConfig().fields,
      ngrok: {
        endpoint_mode: option.ngrokMode ?? "https_edge_termination",
        reserved_domain: domain.domain,
      },
    }

    setBusy(true)
    setError(null)
    void saveRemoteAccessConfig(nextConfig, authtoken.trim())
      .then(result => {
        if (!result.ok) {
          setError(result.message)
          return
        }
        setConfig(asConfig(result.config))
        setPendingPosture(null)
        // The authtoken is now sealed at rest and only the desktop host's
        // config watcher can decrypt it (see the module doc comment); drop
        // the copy here.
        setAuthtoken("")
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
              {runningOption?.label ?? "Public URL"}
            </span>
            <span
              className={cn(
                "pdpp-caption rounded-full border px-2 py-0.5",
                runningOption?.badge === "Provider can read your data"
                  ? "border-destructive/50 text-destructive"
                  : "border-border/80 text-muted-foreground"
              )}
            >
              {/* Never blank and never "unknown" for an active provider. */}
              {runningOption?.badge ?? "Provider can read your data"}
            </span>
          </div>
          <p className="pdpp-caption text-muted-foreground">
            {runningOption?.description ??
              "DataConnect does not operate this connection."}
          </p>
          {originDisplay.kind === "error" ? (
            <div
              className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2"
              role="alert"
            >
              <p className="pdpp-caption text-destructive">
                {originDisplay.guidance.message}
              </p>
              {originDisplay.guidance.suggestSwitchTo === "ngrok_https_edge_termination" ? (
                <button
                  className="justify-self-start rounded-md border border-destructive/50 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  disabled={busy || desktopUnavailable}
                  onClick={switchToNgrokHttps}
                  type="button"
                >
                  Switch to ngrok — HTTPS
                </button>
              ) : null}
            </div>
          ) : (
            <p className="break-all font-mono text-xs text-foreground/80">
              {originDisplay.kind === "origin"
                ? originDisplay.origin
                : "Waiting for the provider to report an address…"}
            </p>
          )}
          {config.provider === "user_supplied_origin" &&
          effectiveConsolePort != null ? (
            <p className="pdpp-caption text-muted-foreground">
              Point your proxy at{" "}
              <span className="font-mono text-foreground/80">
                http://127.0.0.1:{effectiveConsolePort}
              </span>
              {config.console_port != null
                ? ". This port is pinned and will not change on restart."
                : ". This port is not pinned, so it can change the next time DataConnect restarts -- set a fixed port below to stop that."}
            </p>
          ) : null}
          <button
            className="justify-self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            disabled={busy || desktopUnavailable}
            onClick={() => choosePosture("public_url")}
            type="button"
          >
            Change how this is reachable
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
          aria-label="Choose how this Personal Server is reachable"
          className="grid gap-3 rounded-md border border-foreground/20 bg-background px-3 py-3"
          role="dialog"
        >
          <div className="grid gap-1">
            <h3 className="pdpp-caption font-semibold text-foreground">
              Choose a Public URL provider
            </h3>
            <p className="pdpp-caption text-muted-foreground">
              You are already signed in as the owner, so no separate password
              is needed here.
            </p>
          </div>
          <div
            aria-label="Public URL provider"
            className="grid gap-2"
            role="radiogroup"
          >
            <span className="pdpp-caption font-semibold text-foreground">
              How should it be reachable?
            </span>
            {publicUrlOptions.map(option => {
              const chosen = optionId === option.id
              // Only ngrok and the Cloudflare tunnel can be unavailable
              // independent of the whole Public URL flow (see
              // `ngrokUnavailable`/`cloudflareTunnelUnavailable` above) -- a
              // proxy the owner runs has no native dependency and is never
              // disabled by this check.
              const rowUnavailable =
                (option.provider === "ngrok" && ngrokUnavailable) ||
                (option.provider === "cloudflare_tunnel" && cloudflareTunnelUnavailable)
              return (
                <label
                  className={cn(
                    "grid gap-1 rounded-md border px-3 py-2",
                    chosen
                      ? "border-foreground/50 bg-muted/30"
                      : "border-border/70",
                    rowUnavailable ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                  )}
                  key={option.id}
                >
                  <span className="flex items-start gap-3">
                    <input
                      aria-label={option.label}
                      checked={chosen}
                      disabled={busy || rowUnavailable}
                      name="public-url-option"
                      onChange={() => {
                        setOptionId(option.id)
                        setError(null)
                      }}
                      type="radio"
                    />
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="pdpp-caption font-medium text-foreground">
                          {option.label}
                        </span>
                        <span
                          className={cn(
                            "pdpp-caption rounded-full border px-2 py-0.5",
                            option.badge === "Provider can read your data"
                              ? "border-destructive/50 text-destructive"
                              : "border-border/80 text-muted-foreground"
                          )}
                        >
                          {option.badge}
                        </span>
                      </span>
                      <span className="pdpp-caption text-muted-foreground">
                        {option.description}
                      </span>
                      {option.planNote ? (
                        <span className="pdpp-caption text-muted-foreground/80">
                          {option.planNote}
                        </span>
                      ) : null}
                      {rowUnavailable ? (
                        <span className="pdpp-caption text-destructive">
                          {option.provider === "cloudflare_tunnel"
                            ? cloudflareTunnelInspection?.reason ??
                              "Cloudflare Tunnel needs the DataConnect desktop app."
                            : ngrokInspection?.reason ??
                              "ngrok needs the DataConnect desktop app."}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>

          {selectedOption?.provider === "ngrok" ? (
            <>
              <label
                className="grid gap-1 pdpp-caption text-foreground"
                htmlFor="remote-access-authtoken"
              >
                ngrok authtoken
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                  id="remote-access-authtoken"
                  onChange={event => setAuthtoken(event.currentTarget.value)}
                  spellCheck={false}
                  type="password"
                  value={authtoken}
                />
                <span className="pdpp-caption text-muted-foreground">
                  ngrok has no sign-in flow an app can complete for you, so this
                  is a one-time copy and paste. DataConnect stores it in your
                  system keychain and does not ask again.{" "}
                  <OpenExternalLink
                    className="underline"
                    href="https://dashboard.ngrok.com/get-started/your-authtoken"
                  >
                    Open your ngrok authtoken page
                  </OpenExternalLink>
                  . You can sign up with Google or GitHub.
                </span>
              </label>
              <label
                className="grid gap-1 pdpp-caption text-foreground"
                htmlFor="remote-access-ngrok-domain"
              >
                Your ngrok domain
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                  id="remote-access-ngrok-domain"
                  onChange={event =>
                    setNgrokDomain(event.currentTarget.value)
                  }
                  placeholder="your-name.ngrok-free.app"
                  spellCheck={false}
                  type="text"
                  value={ngrokDomain}
                />
                {ngrokDurableAddress.kind === "available" ? (
                  <span className="pdpp-caption text-muted-foreground">
                    Saved. This stays your address across restarts, on the
                    free plan or a paid one.
                  </span>
                ) : (
                  <span className="pdpp-caption text-muted-foreground">
                    Every ngrok account — including the free plan — is
                    assigned one stable domain at signup, at no cost. This app
                    cannot look yours up automatically, so paste it here. Find
                    yours at{" "}
                    <span className="select-all font-mono">
                      dashboard.ngrok.com/domains
                    </span>
                    . Leaving this empty gets a brand-new random hostname
                    every time DataConnect restarts.
                  </span>
                )}
              </label>
            </>
          ) : null}

          {selectedOption?.provider === "cloudflare_tunnel" ? (
            <>
              <label
                className="grid gap-1 pdpp-caption text-foreground"
                htmlFor="remote-access-cloudflare-token"
              >
                Cloudflare tunnel token
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                  id="remote-access-cloudflare-token"
                  onChange={event => setCloudflareToken(event.currentTarget.value)}
                  spellCheck={false}
                  type="password"
                  value={cloudflareToken}
                />
                <span className="pdpp-caption text-muted-foreground">
                  Create a tunnel in the Cloudflare dashboard, then copy its
                  token here. DataConnect stores it in your system keychain
                  and does not ask again. Requires the{" "}
                  <span className="select-all font-mono">cloudflared</span>{" "}
                  binary installed on this machine.{" "}
                  <OpenExternalLink
                    className="underline"
                    href="https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/"
                  >
                    Open Cloudflare Tunnel setup
                  </OpenExternalLink>
                  .
                </span>
              </label>
              <label
                className="grid gap-1 pdpp-caption text-foreground"
                htmlFor="remote-access-cloudflare-hostname"
              >
                Your tunnel hostname
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                  id="remote-access-cloudflare-hostname"
                  onChange={event => setCloudflareHostname(event.currentTarget.value)}
                  placeholder="vault.example.com"
                  spellCheck={false}
                  type="text"
                  value={cloudflareHostname}
                />
                <span className="pdpp-caption text-muted-foreground">
                  The hostname you routed to this tunnel in the Cloudflare
                  dashboard. Unlike ngrok's free plan, a Cloudflare tunnel has
                  no random-hostname fallback — this is required, and it
                  stays your address across restarts.
                </span>
              </label>
            </>
          ) : null}

          {selectedOption?.provider === "user_supplied_origin" ? (
            <>
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
              <label
                className="grid gap-1 pdpp-caption text-foreground"
                htmlFor="remote-access-pinned-port"
              >
                Port your proxy targets (optional)
                <input
                  autoComplete="off"
                  className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                  id="remote-access-pinned-port"
                  inputMode="numeric"
                  onChange={event => setPinnedPort(event.currentTarget.value)}
                  placeholder={
                    effectiveConsolePort != null
                      ? String(effectiveConsolePort)
                      : "4310"
                  }
                  type="text"
                  value={pinnedPort}
                />
                <span className="pdpp-caption text-muted-foreground">
                  {effectiveConsolePort != null
                    ? `Currently running on port ${effectiveConsolePort}. `
                    : ""}
                  Leave this blank to let DataConnect pick a port each
                  restart -- your proxy config would need updating every
                  time. Set a fixed port so your proxy config never goes
                  stale.
                </span>
              </label>
            </>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              disabled={busy}
              onClick={cancelPublicUrlDialog}
              type="button"
            >
              Cancel
            </button>
            <button
              className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90 disabled:opacity-50"
              disabled={
                busy ||
                (selectedOption?.provider === "ngrok" && ngrokUnavailable) ||
                (selectedOption?.provider === "cloudflare_tunnel" && cloudflareTunnelUnavailable)
              }
              onClick={enablePublicUrl}
              type="button"
            >
              {busy ? "Enabling…" : "Enable"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
