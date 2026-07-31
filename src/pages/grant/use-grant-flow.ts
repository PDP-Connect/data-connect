import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useDispatch } from "react-redux"
import { useAuth } from "../../hooks/useAuth"
import { addConnectedApp } from "../../state/store"
import {
  claimSession,
  approveSession,
  denySession,
  SessionRelayError,
} from "../../services/sessionRelay"
import { verifyBuilder, BuilderVerificationError } from "../../services/builder"
import {
  createGrant,
  PersonalServerError,
  revokeGrant,
} from "../../services/personalServer"
import {
  createGithubPdppConsentRequest,
  issueGithubPdppGrant,
} from "../../services/pdppAuthorization"
import { fetchServerIdentity } from "../../services/serverRegistration"
import { usePersonalServer } from "../../hooks/usePersonalServer"
import {
  clearGrantHandoff,
  setGrantHandoffExpiry,
} from "../../lib/grant-handoff"
import {
  clearPendingPdppGrantCompensation,
  getPendingPdppGrantCompensations,
  savePendingPdppGrantCompensation,
} from "../../lib/storage"
import type {
  BuilderManifest,
  GrantFlowParams,
  GrantFlowState,
  GrantSession,
  PrefetchedGrantData,
} from "./types"
import { ROUTES } from "@/config/routes"
import { getClaimedAuthorizationMismatch } from "@/lib/grant-params"
import { getPrimaryScopeToken } from "@/lib/scope-labels"
import { getPlatformRegistryEntryById } from "@/lib/platform/utils"
import {
  trackBuilderVerificationCompleted,
  trackBuilderVerificationFailed,
  trackGrantFlowCompleted,
  trackGrantFlowDenied,
  trackGrantFlowExpired,
  trackGrantFlowFailed,
  trackGrantFlowStarted,
  trackSessionClaimCompleted,
  trackSessionClaimFailed,
} from "@/lib/telemetry/events"

export type PendingApproval = {
  sessionId: string
  secret: string
  grantId: string
  userAddress: string
  serverAddress?: string
  scopes: string[]
  expiresAt: string
}

export function isPendingApprovalRetryAllowed(
  pending: PendingApproval,
  walletAddress: string | null
): boolean {
  const expiresAt = new Date(pending.expiresAt).getTime()
  return Boolean(
    walletAddress &&
    walletAddress === pending.userAddress &&
    !Number.isNaN(expiresAt) &&
    Date.now() <= expiresAt
  )
}

// Demo mode: sessions starting with "grant-session-" use mock data (dev only)
function isDemoSession(sessionId: string): boolean {
  return import.meta.env.DEV && sessionId.startsWith("grant-session-")
}

function createDemoSession(sessionId: string): GrantSession {
  return {
    id: sessionId,
    granteeAddress: "0x0000000000000000000000000000000000000000",
    scopes: ["chatgpt.conversations"],
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    appName: "Demo App",
    appIcon: "🔗",
  }
}

function createDemoBuilderManifest(): BuilderManifest {
  return {
    name: "Demo App",
    description: "A demo application for testing the grant flow.",
    appUrl: "https://example.com",
    privacyPolicyUrl: "https://example.com/privacy",
    termsUrl: "https://example.com/terms",
    verified: true,
  }
}

export function useGrantFlow(
  params: GrantFlowParams,
  prefetched?: PrefetchedGrantData
) {
  const navigate = useNavigate()
  const dispatch = useDispatch()
  const { isAuthenticated, isLoading: authLoading, walletAddress } = useAuth()
  const personalServer = usePersonalServer()
  const [flowState, setFlowState] = useState<GrantFlowState>({
    sessionId: "",
    status: "loading",
  })
  const [isApproving, setIsApproving] = useState(false)
  const [authPending, setAuthPending] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const pendingApprovalRef = useRef<PendingApproval | null>(null)

  const sessionId = params?.sessionId
  const secret = params?.secret
  const handoffId = params?.handoffId
  const hasSuccessOverride = params?.status === "success"
  const pdppAuthorizationDetails = params?.authorizationDetails
  const pdppAuthorizationDetailsKey =
    pdppAuthorizationDetails === undefined
      ? "absent"
      : pdppAuthorizationDetails === null
        ? "invalid"
        : JSON.stringify(pdppAuthorizationDetails)
  const telemetryPlatform = (() => {
    const scopeToken = getPrimaryScopeToken(
      prefetched?.session?.scopes ?? params?.scopes
    )
    return scopeToken
      ? (getPlatformRegistryEntryById(scopeToken)?.id ?? scopeToken)
      : null
  })()

  // Reset auth state when sessionId changes
  useEffect(() => {
    setAuthPending(false)
  }, [sessionId])

  // --- Main flow: load → claim → verify builder → consent ---
  useEffect(() => {
    if (!sessionId) {
      setFlowState({
        sessionId: "",
        status: "error",
        error: "No session ID provided. Please restart the flow from the app.",
      })
      return
    }

    // Guard against stale async updates from React StrictMode double-mount.
    // When StrictMode unmounts the first instance, cleanup sets cancelled=true
    // so the first mount's in-flight async ops don't clobber the second mount's state.
    let cancelled = false

    const enterConsent = async (
      session: GrantSession,
      builderManifest: BuilderManifest
    ) => {
      if (pdppAuthorizationDetails === null) {
        throw new PersonalServerError(
          "The GitHub authorization details are invalid."
        )
      }
      const githubPdppConsentRequest = pdppAuthorizationDetails
        ? await (() => {
            if (!personalServer.port) {
              throw new PersonalServerError(
                "Personal Server is not ready to validate the GitHub authorization request."
              )
            }
            return createGithubPdppConsentRequest(
              personalServer.port,
              {
                sessionId: session.id,
                scopes: session.scopes,
                authorizationDetails: pdppAuthorizationDetails,
              },
              personalServer.devToken
            )
          })()
        : undefined
      if (
        githubPdppConsentRequest &&
        (githubPdppConsentRequest.session_id !== session.id ||
          githubPdppConsentRequest.scopes.length !== session.scopes.length ||
          !githubPdppConsentRequest.scopes.every(scope =>
            session.scopes.includes(scope)
          ))
      ) {
        throw new PersonalServerError(
          "The normalized GitHub authorization does not match the claimed session."
        )
      }
      if (cancelled) return
      setFlowState(prev => ({
        ...prev,
        status: "consent",
        session,
        builderManifest,
        githubPdppConsentRequest,
      }))
    }

    const runFlow = async () => {
      console.log("[GrantFlow] runFlow starting", {
        sessionId,
        hasSecret: Boolean(secret),
        hasPrefetched: Boolean(prefetched),
        prefetchedSessionId: prefetched?.session?.id,
        prefetchedHasBuilder: Boolean(prefetched?.builderManifest),
        isDemoSession: isDemoSession(sessionId),
      })
      trackGrantFlowStarted({ sessionId, platform: telemetryPlatform })
      setFlowState({ sessionId, status: "loading" })

      // --- Demo mode ---
      if (isDemoSession(sessionId)) {
        const session = createDemoSession(sessionId)
        const builderManifest = createDemoBuilderManifest()
        await enterConsent(session, builderManifest)

        return
      }

      // --- Pre-fetched path: connect page already claimed + verified in background ---
      const prefetchedAuthorizationMismatch = prefetched?.session
        ? getClaimedAuthorizationMismatch(sessionId, params.scopes, {
            sessionId: prefetched.session.id,
            scopes: prefetched.session.scopes,
          })
        : null
      if (prefetchedAuthorizationMismatch) {
        setFlowState({
          sessionId,
          status: "error",
          error: prefetchedAuthorizationMismatch,
        })
        return
      }

      if (prefetched?.session && prefetched?.builderManifest) {
        setGrantHandoffExpiry(handoffId, prefetched.session.expiresAt)
        console.log(
          "[GrantFlow] Using pre-fetched data (skipping claim + verify)",
          {
            sessionId: prefetched.session.id,
            builderName: prefetched.builderManifest.name,
          }
        )
        await enterConsent(prefetched.session, prefetched.builderManifest)

        return
      }

      // --- Pre-fetched session only: claim done, builder verification still needed ---
      if (prefetched?.session) {
        setGrantHandoffExpiry(handoffId, prefetched.session.expiresAt)
        console.log(
          "[GrantFlow] Using pre-fetched session (skipping claim, verifying builder)",
          {
            sessionId: prefetched.session.id,
          }
        )
        setFlowState(prev => ({ ...prev, session: prefetched.session }))

        try {
          setFlowState(prev => ({ ...prev, status: "verifying-builder" }))
          const builderManifest = await verifyBuilder(
            prefetched.session.granteeAddress,
            prefetched.session.webhookUrl
          )
          trackBuilderVerificationCompleted({
            sessionId: prefetched.session.id,
            platform: telemetryPlatform,
          })
          if (cancelled) return
          await enterConsent(prefetched.session, builderManifest)
        } catch (error) {
          trackBuilderVerificationFailed({
            sessionId: prefetched.session.id,
            error,
            platform: telemetryPlatform,
          })
          if (cancelled) return
          console.error(
            "[GrantFlow] Builder verification failed (pre-fetched session)",
            {
              sessionId: prefetched.session.id,
              type: error instanceof Error ? error.name : "unknown",
            }
          )
          setFlowState({
            sessionId,
            status: "error",
            error:
              error instanceof BuilderVerificationError
                ? error.message
                : "Failed to verify builder",
          })
        }

        return
      }

      // --- Real flow (no pre-fetched data) ---
      if (!secret) {
        setFlowState({
          sessionId,
          status: "error",
          error:
            "No secret provided. The deep link URL is missing the secret parameter.",
        })
        return
      }

      // Step 1: Claim session
      try {
        console.log(
          "[GrantFlow] Falling back to fresh claim (no pre-fetched data)",
          { sessionId }
        )
        setFlowState(prev => ({ ...prev, status: "claiming" }))
        const claimed = await claimSession({ sessionId, secret })
        trackSessionClaimCompleted({
          sessionId,
          platform: telemetryPlatform,
        })
        if (cancelled) return
        const authorizationMismatch = getClaimedAuthorizationMismatch(
          sessionId,
          params.scopes,
          claimed
        )
        if (authorizationMismatch) {
          setFlowState({
            sessionId,
            status: "error",
            error: authorizationMismatch,
          })
          return
        }
        const session: GrantSession = {
          id: claimed.sessionId,
          granteeAddress: claimed.granteeAddress,
          scopes: claimed.scopes,
          expiresAt: claimed.expiresAt,
          webhookUrl: claimed.webhookUrl,
          appUserId: claimed.appUserId,
        }
        setGrantHandoffExpiry(handoffId, claimed.expiresAt)
        console.log("[GrantFlow] Claim succeeded", {
          sessionId,
          granteeAddress: claimed.granteeAddress,
          scopes: claimed.scopes,
        })
        setFlowState(prev => ({ ...prev, session }))

        // Step 2: Verify builder
        // Protocol spec: "If manifest discovery or signature verification fails,
        // the Desktop App MUST NOT render the consent screen and MUST fail the session flow."
        setFlowState(prev => ({ ...prev, status: "verifying-builder" }))
        const builderManifest = await verifyBuilder(
          claimed.granteeAddress,
          claimed.webhookUrl
        )
        trackBuilderVerificationCompleted({
          sessionId,
          platform: telemetryPlatform,
        })
        if (cancelled) return
        // Advance to consent only after any GitHub terms have been normalized
        // and bound to the claimed session by the Personal Server.
        await enterConsent(session, builderManifest)
      } catch (error) {
        if (error instanceof SessionRelayError) {
          trackSessionClaimFailed({
            sessionId,
            error,
            platform: telemetryPlatform,
          })
        } else if (error instanceof BuilderVerificationError) {
          trackBuilderVerificationFailed({
            sessionId,
            error,
            platform: telemetryPlatform,
          })
        }
        if (cancelled) return
        console.error("[GrantFlow] Flow error", {
          sessionId,
          errorType:
            error instanceof SessionRelayError
              ? "SessionRelayError"
              : error instanceof BuilderVerificationError
                ? "BuilderVerificationError"
                : "unknown",
          ...(error instanceof SessionRelayError && {
            errorCode: error.errorCode,
            statusCode: error.statusCode,
          }),
        })
        setFlowState({
          sessionId,
          status: "error",
          error:
            error instanceof SessionRelayError ||
            error instanceof BuilderVerificationError ||
            error instanceof PersonalServerError
              ? error.message
              : "Failed to load session",
        })
      }
    }

    runFlow()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefetched is stable from navigation state
  }, [
    sessionId,
    secret,
    retryCount,
    pdppAuthorizationDetailsKey,
    handoffId,
    personalServer.devToken,
    personalServer.port,
  ])

  // Handle success override (when returning from connect page)
  useEffect(() => {
    if (!hasSuccessOverride || !flowState.session) return
    if (flowState.status === "success") return
    setFlowState(prev => ({ ...prev, status: "success" }))
  }, [flowState.session, flowState.status, hasSuccessOverride])

  // --- Approve flow ---
  const handleApprove = useCallback(async () => {
    if (!flowState.session) return

    // Auth should already be populated from the deep link (masterKeySig).
    // If missing, the user needs to sign in via account.vana.org first.
    if (!isAuthenticated || !walletAddress) {
      setFlowState(prev => ({
        ...prev,
        status: "error",
        error:
          "Not signed in. Sign in, then relaunch Data Connect from the requesting app.",
      }))
      return
    }

    // If Personal Server isn't fully ready yet (port + tunnel), defer.
    // The auto-approve effect will resume once both are available.
    // The tunnel is required so the builder app can reach the server externally.
    if (!personalServer.port || !personalServer.tunnelUrl) {
      setAuthPending(true)
      setFlowState(prev => ({ ...prev, status: "creating-grant" }))
      return
    }

    setIsApproving(true)

    try {
      // Skip grant creation + session approval for demo sessions
      if (isDemoSession(flowState.sessionId)) {
        trackGrantFlowCompleted({
          sessionId: flowState.sessionId,
          platform: telemetryPlatform,
        })
        setFlowState(prev => ({ ...prev, status: "success" }))
        return
      }

      // Check session expiry before proceeding — better UX than waiting
      // for the server to reject the request.
      if (flowState.session.expiresAt) {
        const expiresAt = new Date(flowState.session.expiresAt).getTime()
        if (!Number.isNaN(expiresAt) && Date.now() > expiresAt) {
          trackGrantFlowExpired({
            sessionId: flowState.sessionId,
            platform: telemetryPlatform,
          })
          throw new SessionRelayError(
            "This session has expired. Please start a new request from the app."
          )
        }
      }

      // A failed PDPP issuance may have left a legacy grant active. Retry its
      // persisted, non-secret compensation before creating another grant.
      const pendingCompensation = getPendingPdppGrantCompensations().find(
        pending => pending.sessionId === flowState.sessionId
      )
      if (pendingCompensation) {
        if (pendingCompensation.userAddress !== walletAddress) {
          throw new PersonalServerError(
            "Sign in with the account that started this approval before retrying it."
          )
        }
        await revokeGrant(
          personalServer.port,
          pendingCompensation.grantId,
          personalServer.devToken
        )
        clearPendingPdppGrantCompensation(pendingCompensation)
      }

      // Step: Create grant via Personal Server
      setFlowState(prev => ({ ...prev, status: "creating-grant" }))

      // Grant expiresAt is intentionally omitted (defaults to 0 = no expiration).
      // The session's expiresAt is an approval-window timeout, not a grant lifetime.
      // Grants live until explicitly revoked by the user.
      const { grantId } = await createGrant(
        personalServer.port,
        {
          granteeAddress: flowState.session.granteeAddress,
          scopes: flowState.session.scopes,
        },
        personalServer.devToken
      )

      if (flowState.githubPdppConsentRequest) {
        const pendingCompensation = {
          sessionId: flowState.sessionId,
          grantId,
          userAddress: walletAddress,
        }
        if (!savePendingPdppGrantCompensation(pendingCompensation)) {
          try {
            await revokeGrant(
              personalServer.port,
              grantId,
              personalServer.devToken
            )
          } catch (revokeError) {
            console.error("[GrantFlow] Unrecorded PDPP compensation failed", {
              type: revokeError instanceof Error ? revokeError.name : "unknown",
            })
          }
          throw new PersonalServerError(
            "Could not securely record grant recovery. The incomplete grant was revoked when possible; restart Data Connect before trying again."
          )
        }
        try {
          await issueGithubPdppGrant(
            personalServer.port,
            {
              requestId: flowState.githubPdppConsentRequest.request_id,
              legacyGrantId: grantId,
              subjectId: walletAddress,
              clientId: flowState.session.granteeAddress,
            },
            personalServer.devToken
          )
        } catch (error) {
          // The legacy grant would otherwise authorize a completed-looking
          // session without its required PDPP credential. Keep the two grants
          // atomic from the requester's perspective when the local issuance
          // step rejects before Session Relay approval.
          try {
            await revokeGrant(
              personalServer.port,
              grantId,
              personalServer.devToken
            )
            clearPendingPdppGrantCompensation(pendingCompensation)
          } catch (revokeError) {
            console.error("[GrantFlow] PDPP grant compensation failed", {
              type: revokeError instanceof Error ? revokeError.name : "unknown",
            })
          }
          throw error
        }
      }

      setFlowState(prev => ({ ...prev, grantId }))

      // Fetch the Personal Server's own address so the builder can resolve
      // the server via Gateway (registered under this address, not the user's).
      const { address: serverAddress } = await fetchServerIdentity(
        personalServer.port
      )

      // Step: Approve session via Session Relay
      setFlowState(prev => ({ ...prev, status: "approving" }))

      if (!secret) {
        throw new SessionRelayError(
          "Cannot approve session because the secure handoff is no longer available. Relaunch from the requesting app."
        )
      }

      pendingApprovalRef.current = {
        sessionId: flowState.sessionId,
        grantId,
        secret,
        userAddress: walletAddress,
        serverAddress,
        scopes: flowState.session.scopes,
        expiresAt: flowState.session.expiresAt,
      }

      await approveSession(flowState.sessionId, {
        secret,
        grantId,
        userAddress: walletAddress,
        serverAddress,
        scopes: flowState.session.scopes,
      })

      pendingApprovalRef.current = null
      clearGrantHandoff(handoffId)

      // Persist as connected app in Redux for immediate UI update
      dispatch(
        addConnectedApp({
          id: grantId,
          name:
            flowState.builderManifest?.name ??
            flowState.session?.appName ??
            `App ${flowState.session.granteeAddress.slice(0, 6)}…${flowState.session.granteeAddress.slice(-4)}`,
          icon: flowState.builderManifest?.icons?.[0]?.src,
          permissions: flowState.session.scopes,
          connectedAt: new Date().toISOString(),
        })
      )

      trackGrantFlowCompleted({
        sessionId: flowState.sessionId,
        platform: telemetryPlatform,
      })
      setFlowState(prev => ({ ...prev, status: "success" }))
    } catch (error) {
      trackGrantFlowFailed({
        sessionId: flowState.sessionId,
        platform: telemetryPlatform,
        error,
      })
      console.error("[GrantFlow] Approve failed", {
        type: error instanceof Error ? error.name : "unknown",
      })
      setFlowState(prev => ({
        ...prev,
        status: "error",
        error:
          error instanceof SessionRelayError ||
          error instanceof PersonalServerError
            ? error.message
            : "Failed to complete the grant flow",
      }))
    } finally {
      setIsApproving(false)
    }
  }, [
    flowState.session,
    flowState.sessionId,
    secret,
    flowState.builderManifest,
    flowState.githubPdppConsentRequest,
    isAuthenticated,
    walletAddress,
    personalServer.port,
    personalServer.tunnelUrl,
    personalServer.devToken,
    dispatch,
    handoffId,
    telemetryPlatform,
  ])

  // Auto-approve after auth is ready and Personal Server is available.
  // Auth is now populated from the deep link, but the Personal Server
  // may still be starting up when the user clicks Allow.
  const preparingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [tunnelTimedOut, setTunnelTimedOut] = useState(false)

  // Start a timeout when entering "preparing-server" — give the tunnel up
  // to 90s before declaring failure. This covers fresh installs where frpc
  // needs time to download/connect.
  useEffect(() => {
    if (flowState.status === "preparing-server" && !preparingTimerRef.current) {
      preparingTimerRef.current = setTimeout(() => {
        setTunnelTimedOut(true)
      }, 90_000)
    }
    if (flowState.status !== "preparing-server" && preparingTimerRef.current) {
      clearTimeout(preparingTimerRef.current)
      preparingTimerRef.current = null
      setTunnelTimedOut(false)
    }
    return () => {
      if (preparingTimerRef.current) {
        clearTimeout(preparingTimerRef.current)
        preparingTimerRef.current = null
      }
    }
  }, [flowState.status])

  useEffect(() => {
    if (!authPending || !isAuthenticated || !walletAddress) return
    if (personalServer.status === "error") {
      setAuthPending(false)
      setFlowState(prev => ({
        ...prev,
        status: "error",
        error: personalServer.error || "Personal Server failed to start.",
      }))
      return
    }
    const isDemo = isDemoSession(flowState.sessionId)
    // During Phase 2 restart, wait for the server to come back up.
    // restartingRef is set synchronously during render so we see it
    // before any stale tunnelFailed state from Phase 1.
    if (!isDemo && personalServer.restartingRef.current) {
      setFlowState(prev =>
        prev.status === "preparing-server"
          ? prev
          : { ...prev, status: "preparing-server" }
      )
      return
    }
    // If the tunnel timed out (90s), surface the error.
    if (tunnelTimedOut) {
      setAuthPending(false)
      setFlowState(prev => ({
        ...prev,
        status: "error",
        error:
          "Could not establish a public tunnel for the Personal Server. The requesting app won't be able to access your data.",
      }))
      return
    }
    if (!isDemo && (!personalServer.port || !personalServer.tunnelUrl)) {
      setFlowState(prev =>
        prev.status === "preparing-server"
          ? prev
          : { ...prev, status: "preparing-server" }
      )
      return
    }
    setAuthPending(false)
    void handleApprove()
  }, [
    authPending,
    handleApprove,
    isAuthenticated,
    walletAddress,
    personalServer.port,
    personalServer.tunnelUrl,
    tunnelTimedOut,
    personalServer.status,
    personalServer.error,
    flowState.sessionId,
  ])

  // --- Retry from error ---
  // Retries approval only while this process still holds the relay capability,
  // for the same authenticated subject and before session expiry.
  const handleRetry = useCallback(() => {
    const pending = pendingApprovalRef.current
    if (pending) {
      if (
        !isAuthenticated ||
        !isPendingApprovalRetryAllowed(pending, walletAddress)
      ) {
        pendingApprovalRef.current = null
        setFlowState(prev => ({
          ...prev,
          status: "error",
          error:
            "This approval retry is no longer available. Relaunch from the requesting app.",
        }))
        return
      }

      void (async () => {
        setIsApproving(true)
        try {
          await approveSession(pending.sessionId, {
            secret: pending.secret,
            grantId: pending.grantId,
            userAddress: pending.userAddress,
            ...(pending.serverAddress && {
              serverAddress: pending.serverAddress,
            }),
            scopes: pending.scopes,
          })
          pendingApprovalRef.current = null
          clearGrantHandoff(handoffId)
          setFlowState(prev => ({ ...prev, status: "success" }))
        } catch (error) {
          console.error("[GrantFlow] Approval retry failed", {
            type: error instanceof Error ? error.name : "unknown",
          })
          setFlowState(prev => ({
            ...prev,
            status: "error",
            error:
              error instanceof SessionRelayError
                ? error.message
                : "Failed to notify the requesting app",
          }))
        } finally {
          setIsApproving(false)
        }
      })()
      return
    }

    const pendingCompensation = getPendingPdppGrantCompensations().find(
      pending => pending.sessionId === flowState.sessionId
    )
    if (pendingCompensation) {
      const personalServerPort = personalServer.port
      if (
        !isAuthenticated ||
        pendingCompensation.userAddress !== walletAddress ||
        !personalServerPort
      ) {
        setFlowState(prev => ({
          ...prev,
          status: "error",
          error:
            "Sign in with the account that started this approval and restart the Personal Server before retrying it.",
        }))
        return
      }

      void (async () => {
        setIsApproving(true)
        try {
          await revokeGrant(
            personalServerPort,
            pendingCompensation.grantId,
            personalServer.devToken
          )
          clearPendingPdppGrantCompensation(pendingCompensation)
          setRetryCount(c => c + 1)
        } catch (error) {
          console.error("[GrantFlow] PDPP grant compensation retry failed", {
            type: error instanceof Error ? error.name : "unknown",
          })
          setFlowState(prev => ({
            ...prev,
            status: "error",
            error: "Could not revoke the incomplete grant. Please retry.",
          }))
        } finally {
          setIsApproving(false)
        }
      })()
      return
    }

    setAuthPending(false)
    setRetryCount(c => c + 1)
  }, [
    flowState.sessionId,
    handoffId,
    isAuthenticated,
    walletAddress,
    personalServer.port,
    personalServer.devToken,
  ])

  // --- Deny flow ---
  // Fire-and-forget the deny call, then navigate away immediately.
  // The user clicked Cancel — they don't need to see a confirmation screen.
  const handleDeny = useCallback(async () => {
    trackGrantFlowDenied({
      sessionId: flowState.sessionId,
      platform: telemetryPlatform,
    })
    if (flowState.sessionId && secret && !isDemoSession(flowState.sessionId)) {
      try {
        await denySession(flowState.sessionId, {
          secret,
          reason: "User declined",
        })
      } catch (error) {
        // Deny failure is non-fatal — still navigate away
        console.warn("[GrantFlow] Deny call failed", {
          type: error instanceof Error ? error.name : "unknown",
        })
      }
    }

    clearGrantHandoff(handoffId)
    navigate(ROUTES.home)
  }, [flowState.sessionId, handoffId, navigate, secret, telemetryPlatform])

  // Helper to get display name from builder manifest or session legacy fields
  const builderName =
    flowState.builderManifest?.name ?? flowState.session?.appName ?? undefined

  const declineHref = ROUTES.home

  return {
    flowState,
    isApproving,
    handleApprove,
    handleDeny,
    handleRetry,
    declineHref,
    authLoading,
    walletAddress,
    builderName,
  }
}
