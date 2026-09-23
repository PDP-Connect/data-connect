"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react"
import { OpenExternalLink } from "@/app/(console)/components/open-external-link.tsx"
import { cn } from "@/lib/utils.ts"
import { LiveReadAt, useLiveQuery } from "../components/live-provider.tsx"
import {
  asCloudflareTunnelInspection,
  CloudflaredBinaryStatus,
  CloudflareTunnelConnectionBanner,
  CloudflareTunnelDomainRequirement,
  CloudflareTunnelSetupSteps,
  CloudflareTunnelTokenStatus,
  CLOUDFLARE_TUNNEL_SETUP_URL,
  useCloudflareTunnelConnectionStatus,
} from "./cloudflare-tunnel-prerequisite.tsx"
import { ConsolePortSetting } from "./console-port-setting.tsx"
import { OriginVerificationStatus } from "./origin-verification-status.tsx"
import {
  loadRemoteAccessStateAction,
  setConsolePortAction,
  setRemoteAccessConfigAction,
} from "./remote-access-actions.ts"
import {
  consolePortStatus,
  DEFAULT_PUBLIC_URL_OPTION_ID,
  ngrokDurableAddressState,
  offRemoteAccessConfig,
  originVerificationDisplay,
  parseOriginVerification,
  privacyBadgeForPosture,
  publicUrlOptionById,
  publicUrlOptions,
  remoteAccessOriginDisplay,
  validateCloudflareTunnelHostname,
  validateNgrokDomain,
  validatePinnedConsolePort,
  validateUserSuppliedOrigin,
  wouldDisconnectRemoteOwner,
  type CloudflareTunnelInspection,
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
  saveConsolePort?: typeof setConsolePortAction
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
    my_devices_only: candidate.my_devices_only ?? null,
    tunnel_error:
      typeof candidate.tunnel_error === "string" ? candidate.tunnel_error : null,
    origin_verified: parseOriginVerification(candidate.origin_verified),
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
      "Reachable from other devices on this network. No third party is involved -- the owner password is the only gate.",
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
  saveConsolePort: suppliedSaveConsolePort,
}: RemoteAccessSettingProps) {
  const loadRemoteAccessState = suppliedLoadState ?? loadRemoteAccessStateAction
  const saveRemoteAccessConfig = suppliedSaveConfig ?? setRemoteAccessConfigAction
  const saveConsolePort = suppliedSaveConsolePort ?? setConsolePortAction
  const [config, setConfig] = useState<RemoteAccessConfig>(
    offRemoteAccessConfig
  )
  // The default config above is a placeholder, not state we have read. Until a
  // load succeeds, we must not paint it as the real posture: rendering "Off"
  // for an unknown state is what let the dishonest badge go unnoticed.
  //
  // `remote-access` is a live topic: a change from another tab, another
  // device, or the desktop supervisor (tunnel_error, origin verification)
  // refetches this state within about a second.
  const remoteAccess = useLiveQuery("remote-access", loadRemoteAccessState)
  // A failed refetch keeps the last read on screen, with the error shown
  // until a later read succeeds.
  const loadState: "loading" | "loaded" | "failed" =
    remoteAccess.data !== undefined ? "loaded" : remoteAccess.isError ? "failed" : "loading"
  const [inspection, setInspection] = useState<RemoteAccessInspection | null>(
    null
  )
  const [ngrokInspection, setNgrokInspection] =
    useState<RemoteAccessInspection | null>(null)
  const [cloudflareTunnelInspection, setCloudflareTunnelInspection] =
    useState<CloudflareTunnelInspection | null>(null)
  const [myDevicesOnlyInspection, setMyDevicesOnlyInspection] =
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
  // The port the desktop supervisor told this console to keep. Differs from
  // `effectiveConsolePort` only when that port was taken at launch; `null`
  // on a host without the desktop supervisor.
  const [stableConsolePort, setStableConsolePort] = useState<number | null>(null)
  const [cloudflareToken, setCloudflareToken] = useState("")
  const [cloudflareHostname, setCloudflareHostname] = useState("")
  const cloudflareTunnelConnection = useCloudflareTunnelConnectionStatus(loadRemoteAccessState)
  // Set only when a submitted change is BOTH risky (wouldDisconnectRemoteOwner)
  // AND this browser tab is itself loaded from the remote origin -- the
  // owner reached this settings page THROUGH the tunnel a provider switch,
  // token rotation, or posture change could tear down. Holds the exact
  // config that was about to be saved, so confirming resubmits it unchanged
  // plus the acknowledgement flag, rather than re-deriving it from form
  // state a second time (which could drift if the owner edited a field
  // between the warning appearing and confirming).
  const [pendingRiskyConfig, setPendingRiskyConfig] = useState<{
    config: RemoteAccessConfig
    providerCredential?: string
  } | null>(null)

  // Form drafts are seeded from the saved state, but only while the Public
  // URL form is closed: a refetch must not overwrite what the owner is typing.
  const draftOpenRef = useRef(false)
  draftOpenRef.current = pendingPosture !== null
  const resumedConnectRef = useRef(false)
  const startCloudflareConnect = cloudflareTunnelConnection.start

  useEffect(() => {
    const next = remoteAccess.data
    if (!next) return
    const {
      config: nextConfig,
      effectiveConsolePort: nextPort,
      stableConsolePort: nextStablePort,
      inspection: nextInspection,
      ngrokInspection: nextNgrokInspection,
      cloudflareTunnelInspection: nextCloudflareTunnelInspection,
      myDevicesOnlyInspection: nextMyDevicesOnlyInspection,
    } = next
    const resolved = asConfig(nextConfig)
    setConfig(resolved)
    setInspection(asInspection(nextInspection))
    setNgrokInspection(asInspection(nextNgrokInspection))
    setCloudflareTunnelInspection(
      asCloudflareTunnelInspection(
        asInspection(nextCloudflareTunnelInspection),
        nextCloudflareTunnelInspection
      )
    )
    setMyDevicesOnlyInspection(asInspection(nextMyDevicesOnlyInspection))
    setEffectiveConsolePort(nextPort ?? null)
    setStableConsolePort(nextStablePort ?? null)
    if (!draftOpenRef.current) {
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
    }
    // Resume showing progress after a page reload mid-connect --
    // otherwise a Cloudflare config with no origin yet and no
    // reported failure renders as the same static "Waiting for the
    // provider to report an address…" line forever, with no
    // indication anything is still happening. This is exactly what
    // the settings-triggered console restart produces: the window
    // reloads Settings while cloudflared may still be connecting.
    // Only on the first read: `start` resets its clock on every call.
    if (
      !resumedConnectRef.current &&
      resolved.provider === "cloudflare_tunnel" &&
      !resolved.fields.PDPP_REFERENCE_ORIGIN &&
      !resolved.tunnel_error
    ) {
      startCloudflareConnect()
    }
    resumedConnectRef.current = true
  }, [remoteAccess.data, startCloudflareConnect])

  const loadErrorRef = useRef<string | null>(null)
  useEffect(() => {
    // The route exists but this request could not answer it. Report the
    // failure instead of falling back to a default that looks real, and
    // clear that report (only that one) once a read succeeds again.
    const loadError = remoteAccess.error ? String(remoteAccess.error) : null
    if (loadError) {
      setError(loadError)
    } else if (loadErrorRef.current) {
      const stale = loadErrorRef.current
      setError(current => (current === stale ? null : current))
    }
    loadErrorRef.current = loadError
  }, [remoteAccess.error])

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
  // Distinct from `cloudflareTunnelUnavailable`: that flag means "no Tauri
  // "My devices only" needs a detected LAN network interface -- unavailable
  // (e.g. no network connection) is a real, distinct state from every other
  // row's `desktopUnavailable`, so it gets its own inspection the same way
  // ngrok/Cloudflare Tunnel do.
  const myDevicesOnlyUnavailable =
    !stateIsKnown || myDevicesOnlyInspection?.availability === "unavailable"
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
  // Evaluated against the clock when the config loads: a reading that was
  // already stale then is shown as stale, never as verified.
  const originVerification = useMemo(
    () => originVerificationDisplay(config, Math.floor(Date.now() / 1000)),
    [config]
  )

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
    if (nextPosture === "my_devices_only") {
      if (myDevicesOnlyUnavailable) {
        setError(
          myDevicesOnlyInspection?.reason ??
            "No LAN network interface was detected on this machine."
        )
        return
      }
      setBusy(true)
      // The LAN address is detected server-side, never submitted from here
      // (see owner-remote-access.ts's my_devices_only POST branch) -- the
      // fields below are placeholders the server overwrites with real,
      // freshly detected values before validating and persisting.
      void saveRemoteAccessConfig({
        posture: "my_devices_only",
        provider: null,
        fields: offRemoteAccessConfig().fields,
      })
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
  /**
   * True only when THIS browser tab is itself loaded from the configured
   * public origin -- the client-side mirror of the reference server's
   * `isRemoteOriginRequest` (`reachability-contract.ts`), which the POST
   * route re-checks authoritatively regardless of what this returns. This
   * is a pre-submit UX signal only (show the warning before the owner does
   * real work, not after a round trip), never the source of truth: the
   * route's own check is what actually protects the owner if this is wrong
   * or bypassed (a stale tab, a differently-configured proxy in front).
   */
  const isBrowserOnRemoteOrigin = (): boolean => {
    if (typeof window === "undefined") return false
    const origin = config.fields.PDPP_REFERENCE_ORIGIN
    if (!origin) return false
    try {
      return new URL(origin).hostname === window.location.hostname
    } catch {
      return false
    }
  }

  /**
   * Shared save path for both Tauri-backed providers (ngrok, Cloudflare
   * Tunnel): checks `wouldDisconnectRemoteOwner` before saving when this
   * tab is on the remote origin, and if risky, shows a confirmation instead
   * of saving immediately -- see `pendingRiskyConfig`'s doc comment. The
   * reference server's POST route enforces the same check authoritatively
   * (`owner-remote-access.ts`), so a bypass here (an old cached bundle, a
   * race) still cannot silently strand the owner; it would instead surface
   * the route's 409 as a plain error, which is safe, just less polished.
   */
  const performSave = (
    nextConfig: RemoteAccessConfig,
    providerCredential: string | undefined,
    onSuccess: (result: { config: RemoteAccessConfig }) => void
  ) => {
    if (
      isBrowserOnRemoteOrigin() &&
      wouldDisconnectRemoteOwner(config, nextConfig, providerCredential !== undefined)
    ) {
      setPendingRiskyConfig({ config: nextConfig, providerCredential })
      return
    }
    setBusy(true)
    setError(null)
    void saveRemoteAccessConfig(nextConfig, providerCredential)
      .then(result => {
        if (!result.ok) {
          setError(result.message)
          return
        }
        setConfig(asConfig(result.config))
        onSuccess(result)
      })
      .catch(reason => setError(String(reason)))
      .finally(() => setBusy(false))
  }

  /**
   * Resubmits `pendingRiskyConfig` exactly as it was built, plus the
   * acknowledgement flag the route requires to bypass its own 409. Runs the
   * SAME success handling every direct `performSave` call does (drop a
   * submitted token from state, clear `pendingPosture`, start the
   * connection poll for Cloudflare) by re-deriving which provider this was
   * and calling the matching cleanup. All three providers can reach this
   * path: `user_supplied_origin` has no credential to drop but its origin
   * can still change under a remote owner, which is exactly the case
   * `wouldDisconnectRemoteOwner` also flags for it.
   */
  const confirmRiskyChangeAndSave = () => {
    if (!pendingRiskyConfig) return
    const { config: nextConfig, providerCredential } = pendingRiskyConfig
    setPendingRiskyConfig(null)
    setBusy(true)
    setError(null)
    void saveRemoteAccessConfig(nextConfig, providerCredential, true)
      .then(result => {
        if (!result.ok) {
          setError(result.message)
          return
        }
        setConfig(asConfig(result.config))
        setPendingPosture(null)
        if (nextConfig.provider === "cloudflare_tunnel") {
          setCloudflareToken("")
          cloudflareTunnelConnection.start()
        } else if (nextConfig.provider === "ngrok") {
          setAuthtoken("")
        }
      })
      .catch(reason => setError(String(reason)))
      .finally(() => setBusy(false))
  }

  /**
   * Pin or unpin the console port alone. Credential-free on purpose: the
   * provider does not change, so the owner is not asked for a token again.
   * Resolves to an error message for `ConsolePortSetting` to show, or `null`.
   */
  const pinConsolePort = async (port: number | null): Promise<string | null> => {
    setBusy(true)
    try {
      const result = await saveConsolePort(port)
      if (!result.ok) return result.message
      const saved = asConfig(result.config)
      setConfig(saved)
      setPinnedPort(saved.console_port != null ? String(saved.console_port) : "")
      return null
    } catch (reason) {
      return String(reason)
    } finally {
      setBusy(false)
    }
  }

  const enablePublicUrl = () => {
    const option = publicUrlOptionById(optionId)
    if (!option) {
      setError("Choose how this Personal Server should be reachable.")
      return
    }
    // Every provider carries the pin: a Cloudflare dashboard route targets
    // a fixed port exactly like an owner's proxy does.
    const portValidation = validatePinnedConsolePort(pinnedPort)
    if (!portValidation.ok) {
      setError(portValidation.message)
      return
    }

    if (option.provider === "user_supplied_origin") {
      if (!configuredOriginValidation.ok) {
        setError(configuredOriginValidation.message)
        return
      }
      const nextConfig: RemoteAccessConfig = {
        posture: "public_url",
        provider: "user_supplied_origin",
        fields: configuredOriginValidation.fields,
        console_port: portValidation.port,
      }
      performSave(nextConfig, undefined, () => {
        setPendingPosture(null)
      })
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
      // no discovery step. The four fields are left empty here anyway: the
      // reference server's validator (`validateCloudflareTunnelConfig`,
      // `reference-implementation/server/remote-access-config.ts`) derives
      // and persists PDPP_REFERENCE_ORIGIN/PDPP_TRUSTED_HOSTS from the
      // hostname itself, so the console never needs to compute or echo back
      // a value it has no way to construct correctly.
      const nextConfig: RemoteAccessConfig = {
        posture: "public_url",
        provider: "cloudflare_tunnel",
        fields: offRemoteAccessConfig().fields,
        cloudflare_tunnel: { hostname: hostname.hostname },
        console_port: portValidation.port,
      }
      performSave(nextConfig, cloudflareToken.trim(), () => {
        setPendingPosture(null)
        // The token is now sealed at rest and only the desktop host's
        // config watcher can decrypt it; drop the copy here.
        setCloudflareToken("")
        // The saved config's PDPP_REFERENCE_ORIGIN is the address cloudflared
        // will serve once connected, not proof it IS connected yet -- the
        // desktop host's config watcher still has to restart the stack and
        // spawn cloudflared, which can take real time. Poll for the actual
        // connection outcome (`CloudflareTunnelConnectionBanner`, rendered
        // in BOTH this form and the steady-state summary below, survives
        // `pendingPosture` clearing) instead of letting the collapsing form
        // make a real "still connecting" state look like silent success.
        cloudflareTunnelConnection.start()
      })
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
      console_port: portValidation.port,
    }

    performSave(nextConfig, authtoken.trim(), () => {
      setPendingPosture(null)
      // The authtoken is now sealed at rest and only the desktop host's
      // config watcher can decrypt it (see the module doc comment); drop
      // the copy here.
      setAuthtoken("")
    })
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
        <LiveReadAt updatedAt={remoteAccess.dataUpdatedAt} />
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
          const unavailable =
            row.posture === "my_devices_only" && myDevicesOnlyUnavailable
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

      {stateIsKnown && config.posture === "my_devices_only" ? (
        <div
          className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3"
          role="alert"
        >
          <p className="pdpp-caption font-medium text-destructive">
            This Personal Server is reachable from every device on this
            network.
          </p>
          <p className="pdpp-caption text-muted-foreground">
            No third party is involved and nothing is relayed off this
            network, but the owner password is the only thing standing
            between this network and the Personal Server. Do not enable this
            on a network you do not trust (shared Wi-Fi, a coffee shop, a
            workplace you do not administer).
          </p>
          <p className="break-all font-mono text-xs text-foreground/80">
            {myDevicesOnlyInspection?.availability === "available"
              ? `http://${myDevicesOnlyInspection.reason}${
                  effectiveConsolePort != null ? `:${effectiveConsolePort}` : ""
                }`
              : "Detecting this machine's network address…"}
          </p>
        </div>
      ) : null}

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
          ) : config.provider === "cloudflare_tunnel" &&
            cloudflareTunnelConnection.status.phase !== "idle" ? (
            // Grounded in the same real "Registered tunnel connection"
            // signal the form above polls for (`CloudflareTunnelConnectionBanner`),
            // not a static line -- this is what stays on screen once
            // `pendingPosture` clears and the form collapses, which is
            // exactly when an owner who just saved needs to see progress
            // instead of a state that never updates itself. `idle` is
            // excluded deliberately: it means no poll ever ran this session
            // (a normal page load of an ALREADY-connected tunnel, since the
            // load effect above only calls `start()` when the origin is
            // still missing) -- falling through to the plain origin line
            // below is correct there, not a gap.
            <CloudflareTunnelConnectionBanner status={cloudflareTunnelConnection.status} />
          ) : (
            <p className="break-all font-mono text-xs text-foreground/80">
              {originDisplay.kind === "origin"
                ? originDisplay.origin
                : "Waiting for the provider to report an address…"}
            </p>
          )}
          {originDisplay.kind === "origin" ? (
            // Where the address actually leads, from the supervisor's
            // origin-proof probe, and what the owner must do about it, from
            // the provider's own `binding` answer. This replaced a
            // Cloudflare-only line claiming "any port -- DataConnect connects
            // the tunnel to the right one itself", which is false for a
            // dashboard-managed tunnel: its route overrides the port
            // DataConnect passes.
            <OriginVerificationStatus
              consolePort={effectiveConsolePort}
              display={originVerification}
              origin={originDisplay.origin}
            />
          ) : null}
          {effectiveConsolePort != null ? (
            // One control for every provider: where the console listens,
            // whether that survives a restart, and the pin. Rendered from
            // `consolePortStatus`, not the provider id -- see
            // `ConsolePortSetting`'s doc comment.
            <ConsolePortSetting
              busy={busy}
              onPin={pinConsolePort}
              pinnedPort={config.console_port ?? null}
              status={consolePortStatus({
                pinnedPort: config.console_port ?? null,
                runningPort: effectiveConsolePort,
                stablePort: stableConsolePort,
              })}
            />
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

      {pendingRiskyConfig ? (
        <div
          aria-label="Confirm a change that could disconnect you"
          className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3"
          role="alertdialog"
        >
          <p className="pdpp-caption font-semibold text-destructive">
            This could disconnect you
          </p>
          <p className="pdpp-caption text-foreground/90">
            You reached this settings page through the tunnel this change
            would replace. If the new settings do not work, you will need
            physical access to this machine to recover — there is no other
            way back in. Double-check the token and hostname above before
            continuing.
          </p>
          <div className="flex gap-2">
            <button
              className="justify-self-start rounded-md border border-destructive/60 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
              disabled={busy}
              onClick={confirmRiskyChangeAndSave}
              type="button"
            >
              Save anyway
            </button>
            <button
              className="justify-self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              disabled={busy}
              onClick={() => setPendingRiskyConfig(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
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
                      {!rowUnavailable && option.provider === "cloudflare_tunnel" ? (
                        <CloudflaredBinaryStatus
                          missing={cloudflareTunnelInspection?.cloudflared_binary_present === false}
                        />
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
              <div className="grid gap-1 rounded-md border border-border/70 bg-muted/10 px-3 py-2">
                <CloudflareTunnelDomainRequirement />
                <CloudflaredBinaryStatus
                  missing={cloudflareTunnelInspection?.cloudflared_binary_present === false}
                />
              </div>
              {/* A <details> disclosure, not an always-visible block: the
                  five-step dashboard walkthrough is real, necessary
                  guidance for someone who has never created a Cloudflare
                  tunnel, but rendering it unconditionally, ahead of the
                  fields it explains, is exactly the "wall of text" an
                  owner skims past without reading -- confirmed live this
                  mattered (Tim: "that page is a wall of text"). Collapsed
                  by default so the visible surface for someone who already
                  knows what to do is just the two fields below; the full
                  steps are one click away, not a scroll away. */}
              <details className="grid gap-1 rounded-md border border-border/70 bg-muted/10 px-3 py-2">
                <summary className="cursor-pointer pdpp-caption font-medium text-foreground/90">
                  New to Cloudflare Tunnel? Show the setup steps
                </summary>
                <div className="pt-1">
                  <CloudflareTunnelSetupSteps />
                </div>
              </details>
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
                <CloudflareTunnelTokenStatus token={cloudflareToken} />
                <span className="pdpp-caption text-muted-foreground">
                  Create a tunnel in the Cloudflare dashboard, then copy its
                  token here. DataConnect stores it in your system keychain
                  and does not ask again.{" "}
                  <OpenExternalLink className="underline" href={CLOUDFLARE_TUNNEL_SETUP_URL}>
                    Open the Cloudflare Tunnel walkthrough
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
                  A subdomain of a domain on your Cloudflare account, e.g.{" "}
                  <span className="select-all font-mono">vault.example.com</span> — not a
                  name Cloudflare picks for you. It stays your address across restarts. A
                  token and hostname that belong to different tunnels will still let
                  cloudflared connect, but requests to this hostname will 404 — double
                  check both came from the same tunnel in the dashboard.
                </span>
              </label>
              <CloudflareTunnelConnectionBanner status={cloudflareTunnelConnection.status} />
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
            </>
          ) : null}
          <label
            className="grid gap-1 pdpp-caption text-foreground"
            htmlFor="remote-access-pinned-port"
          >
            Pin the console port (optional)
            <input
              autoComplete="off"
              className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              id="remote-access-pinned-port"
              inputMode="numeric"
              onChange={event => setPinnedPort(event.currentTarget.value)}
              placeholder={
                effectiveConsolePort != null
                  ? String(effectiveConsolePort)
                  : "7664"
              }
              type="text"
              value={pinnedPort}
            />
            <span className="pdpp-caption text-muted-foreground">
              {effectiveConsolePort != null
                ? `Currently running on port ${effectiveConsolePort}. `
                : ""}
              DataConnect already keeps this port across restarts, and tells
              you if another program took it. Pin a port if a proxy or tunnel
              route must never find the console anywhere else: a pinned port
              that is taken stops DataConnect from starting instead.
            </span>
          </label>
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
