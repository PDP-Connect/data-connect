import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useDispatch } from "react-redux"
import { hashMessage, recoverAddress } from "viem"
import { getAuthRedirectRoute } from "@/config/account-auth"
import {
  buildGrantSearchParams,
  getGrantParamsFromSearchParams,
  type GrantParams,
} from "../lib/grant-params"
import {
  createGrantHandoff,
  getGrantHandoff,
  resolveGrantHandoff,
} from "../lib/grant-handoff"
import { setAuthenticated } from "../state/store"
import { ROUTES } from "@/config/routes"

/**
 * Parse a vana:// deep link URL into GrantParams.
 * Accepts URLs like: vana://connect?sessionId=abc&secret=xyz. Credentials are
 * immediately moved into an in-memory handoff before navigation.
 */
function parseDeepLinkUrl(url: string): GrantParams | null {
  try {
    const parsed = new URL(url)
    const searchParams = parsed.searchParams
    const params = getGrantParamsFromSearchParams(searchParams)
    if (params.sessionId || params.appId) {
      return params
    }
  } catch {
    // Not a valid URL
  }
  return null
}

/**
 * Try to import the Tauri deep-link plugin.
 * Returns null in non-Tauri environments (tests, browser dev).
 */
async function getTauriDeepLink() {
  try {
    return await import("@tauri-apps/plugin-deep-link")
  } catch {
    return null
  }
}

export function useDeepLink() {
  const navigate = useNavigate()
  const location = useLocation()
  const dispatch = useDispatch()
  const [deepLinkParams, setDeepLinkParams] = useState<GrantParams | null>(null)
  const [isDeepLink, setIsDeepLink] = useState(false)
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch

  // Navigate to the appropriate route based on grant params
  const handleGrantParams = (incomingParams: GrantParams) => {
    const handoffId =
      incomingParams.handoffId ?? createGrantHandoff(incomingParams)
    const params = getGrantHandoff(handoffId)
    if (!params) return

    setDeepLinkParams({ handoffId })
    setIsDeepLink(true)

    // Derive wallet address from masterKeySignature and populate auth state
    if (params.masterKeySignature) {
      recoverAddress({
        hash: hashMessage("vana-master-key-v1"),
        signature: params.masterKeySignature as `0x${string}`,
      })
        .then(walletAddress => {
          dispatchRef.current(
            setAuthenticated({
              user: { id: walletAddress },
              walletAddress,
              masterKeySignature: params.masterKeySignature,
            })
          )
        })
        .catch(() => {
          console.error("[DeepLink] Failed to recover address from secure handoff")
        })
    }

    const authRedirectRoute = getAuthRedirectRoute(params.sessionId)
    if (authRedirectRoute) {
      navigateRef.current(`${authRedirectRoute}?handoff=${handoffId}`, { replace: true })
      return
    }

    const normalizedSearch = buildGrantSearchParams({ handoffId }).toString()
    const targetSearch = normalizedSearch ? `?${normalizedSearch}` : ""
    const targetRoute =
      params.status === "success" ? ROUTES.grant : ROUTES.connect

    navigateRef.current(`${targetRoute}${targetSearch}`, { replace: true })
  }

  // Listen for native deep link events (Tauri plugin)
  useEffect(() => {
    let unlisten: (() => void) | undefined

    const setupNativeDeepLink = async () => {
      const deepLink = await getTauriDeepLink()
      if (!deepLink) return

      // Check if app was launched via deep link
      const startUrls = await deepLink.getCurrent()
      if (startUrls && startUrls.length > 0) {
        for (const url of startUrls) {
          const params = parseDeepLinkUrl(url)
          if (params) {
            handleGrantParams(params)
            break
          }
        }
      }

      // Listen for deep links while app is running
      unlisten = await deepLink.onOpenUrl((urls: string[]) => {
        for (const url of urls) {
          const params = parseDeepLinkUrl(url)
          if (params) {
            handleGrantParams(params)
            break
          }
        }
      })
    }

    setupNativeDeepLink()

    return () => {
      unlisten?.()
    }
    // Only run once on mount — native deep links are global events
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fallback: check URL query params (dev mode, direct navigation)
  useEffect(() => {
    const urlParams = new URLSearchParams(location.search)
    const routeParams = getGrantParamsFromSearchParams(urlParams)
    const hasSensitiveParams = Boolean(
      routeParams.secret || routeParams.masterKeySignature
    )
    const handoffId =
      routeParams.handoffId ??
      (hasSensitiveParams ? createGrantHandoff(routeParams) : undefined)
    const params = resolveGrantHandoff(handoffId ? { handoffId } : routeParams)

    if (params.sessionId || params.appId) {
      setDeepLinkParams(handoffId ? { handoffId } : params)
      setIsDeepLink(true)

      // Derive wallet address from masterKeySignature and populate auth state
      if (params.masterKeySignature) {
        recoverAddress({
          hash: hashMessage("vana-master-key-v1"),
          signature: params.masterKeySignature as `0x${string}`,
        })
          .then(walletAddress => {
            dispatchRef.current(
              setAuthenticated({
                user: { id: walletAddress },
                walletAddress,
                masterKeySignature: params.masterKeySignature,
              })
            )
          })
          .catch(() => {
            console.error("[DeepLink] Failed to recover address from secure handoff")
          })
      }

      const authRedirectRoute = getAuthRedirectRoute(params.sessionId)
      if (authRedirectRoute) {
        const search = buildGrantSearchParams(handoffId ? { handoffId } : params).toString()
        if (location.pathname !== authRedirectRoute || location.search !== `?${search}`) {
          navigate(`${authRedirectRoute}?${search}`, { replace: true })
        }
        return
      }

      const normalizedSearch = buildGrantSearchParams(handoffId ? { handoffId } : params).toString()
      const targetSearch = normalizedSearch ? `?${normalizedSearch}` : ""
      const targetRoute =
        params.status === "success" || location.pathname === ROUTES.grant
          ? ROUTES.grant
          : ROUTES.connect
      const isAlreadyOnTarget =
        location.pathname === targetRoute && location.search === targetSearch
      if (!isAlreadyOnTarget) {
        navigate(`${targetRoute}${targetSearch}`, { replace: true })
      }
    }
  }, [location.pathname, location.search, navigate])

  return { deepLinkParams, isDeepLink }
}
