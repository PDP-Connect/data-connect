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
}

// One setup card per service. The host keeps one entry per service; if a
// response ever carries two, the later one wins, so two cards cannot show.
export function setupCards(services: ServiceEntry[] | undefined): SetupReservation[] {
  const byService = new Map<string, ServiceEntry>()
  for (const entry of services ?? []) {
    if (entry.setup) byService.set(entry.providerId, entry)
  }
  return [...byService.values()].map(entry => ({
    operationId: entry.setup!.operationId,
    providerId: entry.providerId,
    providerLabel: entry.providerLabel,
    draftId: entry.draftId,
    actionId: entry.setup!.actionId,
    expectedConfigurationRevision: entry.setup!.expectedConfigurationRevision,
    usage: entry.usage,
  }))
}
