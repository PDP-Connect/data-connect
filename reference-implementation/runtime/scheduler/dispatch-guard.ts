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
 * next interval tick re-evaluates. The read is also raced against the dispatch
 * abort signal and, when `deadlineMs` is finite and positive, a deadline: a read
 * that never settles invalidates the dispatch instead of holding its lease, and
 * a late result is ignored.
 */
export async function automaticDispatchStillValid(
  signal: AbortSignal | undefined,
  readScheduleEnabled: ((connectorInstanceId: string) => Promise<boolean>) | undefined,
  connectorInstanceId: string,
  deadlineMs?: number
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  if (readScheduleEnabled) {
    try {
      if (!(await raceAbortAndDeadline(readScheduleEnabled(connectorInstanceId), signal, deadlineMs))) {
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

// Resolves `false` when `signal` aborts or `deadlineMs` elapses before `pending`
// settles. `pending` keeps running unawaited; its late result or rejection has
// no effect.
async function raceAbortAndDeadline(
  pending: Promise<boolean>,
  signal: AbortSignal | undefined,
  deadlineMs: number | undefined
): Promise<boolean> {
  pending.catch(() => undefined);
  let release = (): void => undefined;
  const cut = new Promise<false>((resolve) => {
    const onAbort = (): void => resolve(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      deadlineMs !== undefined && Number.isFinite(deadlineMs) && deadlineMs > 0
        ? setTimeout(() => {
            console.error("[scheduler] schedule re-read exceeded its deadline; dropping dispatch");
            resolve(false);
          }, deadlineMs)
        : undefined;
    timer?.unref?.();
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
