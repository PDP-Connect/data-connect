// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type CertifiedStreamFailureEvidence, endsFailureStreak } from "../scheduler-backoff.ts";

/** Legacy gap rows without an instance belong only to the connector default. */
export function matchesRecoveryInstance(
  rowInstanceId: unknown,
  requestedInstanceId: string,
  defaultInstanceId: string
): boolean {
  return (rowInstanceId || defaultInstanceId) === requestedInstanceId;
}

export async function resolveSchedulerMarkers(
  checker: (
    connectorId: string,
    connectorInstanceId: string,
    prefix: string,
    reasonClass: string,
    sinceCompletedAt: string | null
  ) => Promise<boolean> | boolean,
  connectorId: string,
  connectorInstanceId: string,
  history: readonly (CertifiedStreamFailureEvidence & { completedAt: string })[],
  reasonClass: string,
  backoffStarted: boolean,
  gaveUp: boolean
): Promise<{ readonly backoffStarted: boolean; readonly gaveUp: boolean }> {
  // Same streak boundary as the counter walk and the in-history marker scan.
  const sinceCompletedAt = history.findLast(endsFailureStreak)?.completedAt ?? null;
  const [legacyBackoffStarted, legacyGaveUp] = await Promise.all([
    checker(connectorId, connectorInstanceId, "schedule.back_off.started:", reasonClass, sinceCompletedAt),
    checker(connectorId, connectorInstanceId, "schedule.gave_up:", reasonClass, sinceCompletedAt),
  ]);
  return {
    backoffStarted: [backoffStarted, legacyBackoffStarted].includes(true),
    gaveUp: [gaveUp, legacyGaveUp].includes(true),
  };
}
