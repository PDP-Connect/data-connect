// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** The route whose proof the page keeps fresh, and when to look at it next. */
export type RecheckTarget = { id: string; generation: number; delay: number; key: string };
export type CheckOutcome = { ok: true } | { ok: false; code: string };

/** A later check never starts sooner than this after the last one, so a host that never moves its window is not asked in a tight loop. */
export const MIN_REPEAT_MS = 10_000;
/** A failed check is tried once more this soon, so one slow answer does not end the checking. */
export const RETRY_AFTER_FAILURE_MS = 3_000;
/** Failed checks in a row before the page gives up and tells the owner. */
export const FAILURES_BEFORE_GIVING_UP = 2;

export type RecheckDeps = {
  /** Sends one check and refreshes the page's view of the route. */
  run: (target: RecheckTarget) => Promise<CheckOutcome>;
  /** The check failed too often in a row. */
  giveUp: (id: string, code: string) => void;
  now: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

/**
 * Keeps one route's proof fresh for as long as it is the target. Each finished
 * check schedules the next one, whether or not the host moved its proof window:
 * a window that did not move is no reason to stop asking. A failed check is
 * retried once before the page gives up.
 */
export function createRecheckLoop(deps: RecheckDeps) {
  let latest: RecheckTarget | null = null;
  let timer: unknown;
  let scheduledFor: string | null = null;
  let running = false;
  let failures = 0;
  let stopped = false;

  const clear = () => {
    if (timer !== undefined) deps.clearTimer(timer);
    timer = undefined;
    scheduledFor = null;
  };
  const schedule = (ms: number) => {
    clear();
    if (!latest) return;
    scheduledFor = `${latest.key}|${latest.delay}`;
    timer = deps.setTimer(() => {
      timer = undefined;
      scheduledFor = null;
      void fire();
    }, Math.max(0, ms));
  };
  async function fire() {
    const target = latest;
    if (!target || running || stopped) return;
    running = true;
    let outcome: CheckOutcome;
    try {
      outcome = await deps.run(target);
    } catch {
      outcome = { ok: false, code: "service_unreachable" };
    } finally {
      running = false;
    }
    if (stopped || latest?.id !== target.id) return;
    if (outcome.ok) {
      failures = 0;
      schedule(Math.max(latest.delay, MIN_REPEAT_MS));
      return;
    }
    failures += 1;
    if (failures >= FAILURES_BEFORE_GIVING_UP) {
      failures = 0;
      latest = null;
      deps.giveUp(target.id, outcome.code);
      return;
    }
    schedule(RETRY_AFTER_FAILURE_MS);
  }

  return {
    /**
     * The route to keep fresh now, or null for none. A new route or a new proof
     * window or wait restarts the wait from now; the same window leaves a wait as it is.
     */
    track(target: RecheckTarget | null) {
      if (stopped) return;
      if (!target) {
        latest = null;
        failures = 0;
        clear();
        return;
      }
      const changedRoute = latest?.id !== target.id || latest?.generation !== target.generation;
      latest = target;
      if (changedRoute) failures = 0;
      if (running) return;
      if (timer === undefined || scheduledFor !== `${target.key}|${target.delay}`) schedule(target.delay);
    },
    stop() {
      stopped = true;
      latest = null;
      clear();
    },
  };
}
