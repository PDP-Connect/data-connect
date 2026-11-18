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
        providerLabel: entry.providerLabel,
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
        providerLabel: `${entry.providerLabel} (left over)`,
        actionId: "",
        expectedConfigurationRevision: "",
      })
    }
    return cards
  })
}
