// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
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
  resolveGrantHandoff,
} from "../lib/grant-handoff"
import { setAuthenticated } from "../state/store"
import { ROUTES } from "@/config/routes"

export function useDeepLink() {
  const navigate = useNavigate()
  const location = useLocation()
  const dispatch = useDispatch()
  const [deepLinkParams, setDeepLinkParams] = useState<GrantParams | null>(null)
  const [isDeepLink, setIsDeepLink] = useState(false)
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch

  // Grant params arrive as route query params (direct navigation, dev mode)
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
