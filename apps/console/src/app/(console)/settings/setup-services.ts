// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { SetupReservation } from "./provider-setup.tsx"

// A service as the host reports it in /state: its draft and its setup.
export type ServiceEntry = {
  providerId: string
  providerLabel: string
  draftId: string | null
  usage: string | null
  committed: boolean
  setup: {
    operationId: string
    actionId: string
    expectedConfigurationRevision: string
  } | null
  // Setup operations the host still holds for this service that it does not
  // use. Each one is shown so it can be cancelled.
  cleanup?: string[]
}

// Card copy names a service by its family ("Sign in to Tailscale"), not by the way's own label
// ("Tailscale Funnel"). Provider ids are the host's (gozar catalog: tailscale-funnel, tailscale-private,
// ngrok-*, cloudflare-named). A provider with no known family keeps the label the host gave it.
const families: [prefix: string, name: string][] = [
  ["tailscale-", "Tailscale"],
  ["ngrok-", "ngrok"],
  ["cloudflare-", "Cloudflare"],
]
export function familyName(providerId: string, label: string): string {
  return families.find(([prefix]) => providerId.startsWith(prefix))?.[1] ?? label
}

// The last non-empty entry for a provider wins.
export function setupCards(services: ServiceEntry[] | undefined): SetupReservation[] {
  const byService = new Map<string, ServiceEntry>()
  for (const entry of services ?? []) {
    if (entry.setup || entry.cleanup?.length) byService.set(entry.providerId, entry)
  }
  return [...byService.values()].flatMap(entry => {
    const base = {
      providerId: entry.providerId,
      draftId: entry.draftId,
      usage: entry.usage,
    }
    const cards: SetupReservation[] = []
    const seen = new Set<string>()
    if (entry.setup) {
      seen.add(entry.setup.operationId)
      cards.push({
        ...base,
        operationId: entry.setup.operationId,
        ...(entry.cleanup?.includes(entry.setup.operationId) ? { cleanup: true } : {}),
        providerLabel: familyName(entry.providerId, entry.providerLabel),
        actionId: entry.setup.actionId,
        expectedConfigurationRevision: entry.setup.expectedConfigurationRevision,
      })
    }
    for (const operationId of entry.cleanup ?? []) {
      if (seen.has(operationId)) continue
      seen.add(operationId)
      cards.push({
        ...base,
        operationId,
        providerLabel: `${familyName(entry.providerId, entry.providerLabel)} (left over)`,
        cleanup: true,
        actionId: "",
        expectedConfigurationRevision: "",
      })
    }
    return cards
  })
}
