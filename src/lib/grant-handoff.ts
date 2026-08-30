// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  buildGrantSearchParams,
  getGrantParamsFromSearchParams,
  type GrantParams,
} from "./grant-params"

type GrantHandoff = {
  params: GrantParams
  expiresAt?: number
}

const handoffs = new Map<string, GrantHandoff>()

function createHandoffId(): string {
  return crypto.randomUUID()
}

export function createGrantHandoff(params: GrantParams): string {
  const handoffId = createHandoffId()
  handoffs.set(handoffId, { params: { ...params, handoffId: undefined } })
  return handoffId
}

export function getGrantHandoff(handoffId: string | undefined): GrantParams | null {
  if (!handoffId) return null
  const handoff = handoffs.get(handoffId)
  if (!handoff) return null
  if (handoff.expiresAt !== undefined && Date.now() > handoff.expiresAt) {
    handoffs.delete(handoffId)
    return null
  }
  return { ...handoff.params, handoffId }
}

export function resolveGrantHandoff(params: GrantParams): GrantParams {
  return params.handoffId ? (getGrantHandoff(params.handoffId) ?? params) : params
}

export function setGrantHandoffExpiry(
  handoffId: string | undefined,
  expiresAt: string | undefined
): void {
  if (!handoffId || !expiresAt) return
  const handoff = handoffs.get(handoffId)
  if (!handoff) return
  const expiresAtMs = new Date(expiresAt).getTime()
  if (!Number.isNaN(expiresAtMs)) {
    handoffs.set(handoffId, { ...handoff, expiresAt: expiresAtMs })
  }
}

export function clearGrantHandoff(handoffId: string | undefined): void {
  if (handoffId) handoffs.delete(handoffId)
}

function hasSensitiveGrantParams(params: GrantParams): boolean {
  return Boolean(params.secret || params.masterKeySignature)
}

export function redactBrowserGrantHandoff(): void {
  if (typeof window === "undefined") return
  const params = getGrantParamsFromSearchParams(
    new URLSearchParams(window.location.search)
  )
  if (!hasSensitiveGrantParams(params)) return
  const handoffId = createGrantHandoff(params)
  const redactedSearch = buildGrantSearchParams({ handoffId }).toString()
  const redactedUrl = `${window.location.pathname}?${redactedSearch}${window.location.hash}`
  window.history.replaceState(window.history.state, "", redactedUrl)
}

export function _resetGrantHandoffs(): void {
  handoffs.clear()
}
