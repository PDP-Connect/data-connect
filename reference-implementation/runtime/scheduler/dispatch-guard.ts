// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * next interval tick re-evaluates.
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
      if (!(await readScheduleEnabled(connectorInstanceId))) {
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
