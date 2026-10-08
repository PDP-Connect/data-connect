/**
 * Simulated clocks for the lease prototype tests and the toy trainer.
 *
 * `trueMs` is real time, the oracle the tests check against. The worker sees
 * only `monotonicMs()` and `trustedTime()`, which the test can make stall
 * (system suspend), jump backward (clock rollback) or go missing.
 */
import type { TrustedTimeReading, WorkerClock } from "./worker.ts";

export class SimClock implements WorkerClock {
  trueMs: number;
  #monoMs = 0;
  /** Offset of the trusted reading from true time; a rollback makes it negative. */
  trustedOffsetMs = 0;
  uncertaintyMs = 50;
  trustedAvailable = true;

  constructor(startMs: number) {
    this.trueMs = startMs;
  }

  monotonicMs(): number {
    return this.#monoMs;
  }

  trustedTime(): TrustedTimeReading | null {
    if (!this.trustedAvailable) {
      return null;
    }
    return {
      nowMs: this.trueMs + this.trustedOffsetMs,
      uncertaintyMs: this.uncertaintyMs,
    };
  }

  advance(ms: number): void {
    this.trueMs += ms;
    this.#monoMs += ms;
  }

  /** System suspend: real time passes, CLOCK_MONOTONIC does not. */
  suspend(ms: number): void {
    this.trueMs += ms;
  }

  /** A new process: the monotonic clock has an unrelated origin. */
  restartProcess(): void {
    this.#monoMs = 0;
  }
}
