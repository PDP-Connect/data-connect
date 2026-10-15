// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Simulated clock for the reminder service. Business decisions (weekly read
// cadence, due doses, the daily status check, the 48 h stop-use and 30-day
// deletion bounds) use `now()`. OAuth token expiry stays on the real wall
// clock because the AS mints expiries in real time.

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

export interface Clock {
  now: () => number;
}

/** `--now <ISO>` pins the clock; `--clock-offset-days N` shifts real time. */
export function createClock(opts: { fixedNow?: string | null; offsetMs?: number } = {}): Clock {
  if (opts.fixedNow) {
    const fixed = Date.parse(opts.fixedNow);
    if (!Number.isFinite(fixed)) {
      throw new Error(`invalid --now value: ${opts.fixedNow}`);
    }
    return { now: () => fixed };
  }
  const offset = opts.offsetMs ?? 0;
  return { now: () => Date.now() + offset };
}

/** A clock tests and simulations can move. */
export class ManualClock implements Clock {
  private current: number;
  constructor(start: string | number) {
    this.current = typeof start === "number" ? start : Date.parse(start);
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(at: string | number): void {
    this.current = typeof at === "number" ? at : Date.parse(at);
  }
}
