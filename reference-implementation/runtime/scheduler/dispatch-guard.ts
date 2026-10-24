// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { DispatchEscalationHandler, HumanRequiredStateEscalationHandler } from "../scheduler-domain-types.ts";

/**
 * Deadline for the one single-row schedule read that revalidates a dispatch. A
 * healthy store answers in milliseconds, so a read still pending after this long
 * is treated as failed. It is deliberately not the pre-launch liveness ceiling
 * (30 minutes by default), which bounds the whole gate cascade: a stuck read
 * holds the dispatch's durable active-run lease and its `activeRuns` key for as
 * long as it is awaited, and the next interval tick retries the dispatch.
 */
export const SCHEDULE_READ_DEADLINE_MS = 30_000;

/**
 * The single validity guard for an AUTOMATIC scheduler dispatch.
 *
 * A dispatch is valid while (a) the scheduler epoch it captured at its tick has
 * not been aborted by `stop()` and (b) the schedule's CURRENT durable `enabled`
 * flag is still true. Callers run it immediately before every automatic attempt
 * starts (first attempt and each retry, direct and managed, after any await
 * including lease acquisition) and before any side effect of the dispatch
 * (last-run stamp, needs-human, run record, escalation push). An invalid
 * dispatch is dropped: no run, no record, no retry.
 *
 * The enabled read is fail-closed: a store error invalidates this dispatch; the
 * next interval tick re-evaluates. The read is also raced against the dispatch
 * abort signal and `SCHEDULE_READ_DEADLINE_MS`: a read that never settles
 * invalidates the dispatch instead of holding its lease, and a late result is
 * ignored.
 */
export async function automaticDispatchStillValid(
  signal: AbortSignal | undefined,
  readScheduleEnabled: ((connectorInstanceId: string) => Promise<boolean>) | undefined,
  connectorInstanceId: string
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  if (readScheduleEnabled) {
    try {
      if (!(await raceAbortAndDeadline(readScheduleEnabled(connectorInstanceId), signal))) {
        return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] failed to re-read schedule for ${connectorInstanceId}; dropping dispatch: ${message}`);
      return false;
    }
  }
  return !signal?.aborted;
}

/**
 * Binds the scheduler's escalation callback to the automatic dispatch that raises
 * each escalation. The caller passes that dispatch's own epoch signal; nothing
 * is read from the scheduler's current state. An escalation with no signal has
 * nothing to bind to, and one whose epoch was aborted is stale: both are dropped.
 * The handler gets a `shouldDeliver` that revalidates the dispatch (epoch signal
 * and schedule still enabled) for it to call right before its own side effect.
 */
export function bindDispatchEscalation(
  handler: HumanRequiredStateEscalationHandler,
  stillValid: (signal: AbortSignal | undefined, connectorInstanceId: string) => Promise<boolean>
): DispatchEscalationHandler {
  return (info, signal) => {
    if (!signal || signal.aborted) {
      return "dropped";
    }
    return handler({ ...info, shouldDeliver: () => stillValid(signal, info.connectorInstanceId) });
  };
}

// Resolves `false` when `signal` aborts or `SCHEDULE_READ_DEADLINE_MS` elapses
// before `pending` settles. `pending` keeps running unawaited; its late result
// or rejection has no effect.
async function raceAbortAndDeadline(pending: Promise<boolean>, signal: AbortSignal | undefined): Promise<boolean> {
  pending.catch(() => undefined);
  let release = (): void => undefined;
  const cut = new Promise<false>((resolve) => {
    const onAbort = (): void => resolve(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      console.error("[scheduler] schedule re-read exceeded its deadline; dropping dispatch");
      resolve(false);
    }, SCHEDULE_READ_DEADLINE_MS);
    timer.unref?.();
    release = (): void => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
  });
  try {
    return await Promise.race([pending, cut]);
  } finally {
    release();
  }
}
