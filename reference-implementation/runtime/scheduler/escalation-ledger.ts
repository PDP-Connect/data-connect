// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { DispatchEscalationHandler } from "../scheduler-domain-types.ts";

/**
 * Delivery state of the §10-F escalations a scheduler raises.
 *
 * The announce-once audit state (`notifiedNeedsHumanSkips`, `announcedBlockedClass`)
 * says "this skip / `gave_up` record was written". It must not also stand for
 * "the push was delivered": a push the handler drops (the scheduler was stopped,
 * the schedule disabled, the final schedule read failed) was never delivered, and
 * the audit mark alone would keep the unresolved flag silent for good.
 *
 * The ledger keeps the delivery side apart:
 *   - an escalation is in flight from `raise` until its handler settles, and a
 *     second `raise` for the same flag meanwhile is ignored (at most one real
 *     delivery at a time);
 *   - a handler that answers `"dropped"` leaves the escalation undelivered, so the
 *     gate or governor raises it again on the next valid tick;
 *   - `clear` forgets the escalation once the flag or streak it belongs to ends.
 */
export interface EscalationLedger {
  clear: (reason: string, connectorInstanceId: string) => void;
  isUndelivered: (reason: string, connectorInstanceId: string) => boolean;
  raise: (
    handler: DispatchEscalationHandler,
    info: Parameters<DispatchEscalationHandler>[0],
    signal: AbortSignal | undefined
  ) => void;
}

export function createEscalationLedger(): EscalationLedger {
  const inFlight = new Set<string>();
  const undelivered = new Set<string>();
  const keyOf = (reason: string, connectorInstanceId: string): string => `${reason}\u0000${connectorInstanceId}`;

  return {
    clear(reason, connectorInstanceId) {
      undelivered.delete(keyOf(reason, connectorInstanceId));
    },
    isUndelivered(reason, connectorInstanceId) {
      const key = keyOf(reason, connectorInstanceId);
      return undelivered.has(key) && !inFlight.has(key);
    },
    raise(handler, info, signal) {
      const key = keyOf(info.reason, info.connectorInstanceId);
      if (inFlight.has(key)) {
        return;
      }
      inFlight.add(key);
      undelivered.delete(key);
      let pending: Promise<void | "dropped">;
      try {
        pending = Promise.resolve(handler(info, signal));
      } catch (err) {
        pending = Promise.reject(err);
      }
      pending
        .then(
          (outcome) => {
            if (outcome === "dropped") {
              undelivered.add(key);
            }
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[scheduler] §10-F ${info.reason} escalation callback failed for ${info.connectorId}: ${message}`
            );
          }
        )
        .finally(() => {
          inFlight.delete(key);
        });
    },
  };
}
