/**
 * Client-side lease renewal (lease note L2, L8, L11).
 *
 * Renewal starts no later than half-life; jitter only moves it earlier. A
 * failed renewal retries with capped exponential backoff until the current
 * lease expires. After that the client holds no authority for that grant
 * until a renewal succeeds.
 *
 * The renewer is driven by `step(nowMs)`, which performs due work and returns
 * the next wake time. Tests advance a simulated clock; production code would
 * sleep until the returned time.
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */
import { decodeCompactJws } from "./jws.ts";
import type { JobRecorder } from "./worker.ts";

export interface RenewalPolicy {
  /** Maximum jitter. Applied only earlier than half-life. */
  jitterMaxMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_RENEWAL_POLICY: RenewalPolicy = {
  jitterMaxMs: 60_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
};

/** L2: the latest time a client may start renewing. */
export function latestRenewalStartMs(iatMs: number, expMs: number): number {
  return iatMs + (expMs - iatMs) / 2;
}

export function plannedRenewalAtMs(
  iatMs: number,
  expMs: number,
  policy: RenewalPolicy,
  random: () => number,
): number {
  const latest = latestRenewalStartMs(iatMs, expMs);
  const jitter = Math.min(policy.jitterMaxMs, (expMs - iatMs) / 2);
  return Math.max(iatMs, latest - random() * jitter);
}

/** Next retry time, or null when the lease has already expired. */
export function nextRetryAtMs(
  nowMs: number,
  attempt: number,
  expMs: number | null,
  policy: RenewalPolicy,
  random: () => number,
): number {
  const backoff = Math.min(
    policy.backoffMaxMs,
    policy.backoffBaseMs * 2 ** attempt,
  );
  const delay = backoff / 2 + (random() * backoff) / 2;
  const at = nowMs + delay;
  // Keep trying past expiry too: the client wants authority back as soon as
  // the AS answers. It holds none in the meantime.
  return expMs !== null && nowMs < expMs ? Math.min(at, expMs) : at;
}

export type LeaseFetchResult =
  | { ok: true; lease: string }
  | { ok: false; error: string; terminal: boolean };

export interface HeldLease {
  token: string;
  jti: string;
  iatMs: number;
  expMs: number;
}

export interface RenewerOptions {
  grantId: string;
  fetchLease: () => Promise<LeaseFetchResult>;
  onLease: (lease: HeldLease) => void;
  recorder: JobRecorder;
  policy?: RenewalPolicy;
  random?: () => number;
}

export class LeaseRenewer {
  readonly grantId: string;
  readonly #fetch: () => Promise<LeaseFetchResult>;
  readonly #onLease: (lease: HeldLease) => void;
  readonly #recorder: JobRecorder;
  readonly #policy: RenewalPolicy;
  readonly #random: () => number;
  #held: HeldLease | null = null;
  #nextAttemptAtMs = Number.NEGATIVE_INFINITY;
  #failedAttempts = 0;
  #terminal: string | null = null;
  readonly attempts: number[] = [];

  constructor(opts: RenewerOptions) {
    this.grantId = opts.grantId;
    this.#fetch = opts.fetchLease;
    this.#onLease = opts.onLease;
    this.#recorder = opts.recorder;
    this.#policy = opts.policy ?? DEFAULT_RENEWAL_POLICY;
    this.#random = opts.random ?? Math.random;
  }

  get held(): HeldLease | null {
    return this.#held;
  }

  get terminal(): string | null {
    return this.#terminal;
  }

  /** True while the held lease is unexpired at `nowMs` (client-side view). */
  hasAuthority(nowMs: number): boolean {
    return this.#held !== null && nowMs < this.#held.expMs;
  }

  /** Perform due work and return the next wake time, or null when stopped. */
  async step(nowMs: number): Promise<number | null> {
    if (this.#terminal) {
      return null;
    }
    if (nowMs < this.#nextAttemptAtMs) {
      return this.#nextAttemptAtMs;
    }
    this.attempts.push(nowMs);
    const result = await this.#fetch();
    if (result.ok) {
      const decoded = decodeCompactJws(result.lease);
      const iat = decoded?.payload.iat;
      const exp = decoded?.payload.exp;
      const jti = decoded?.payload.jti;
      if (
        typeof iat !== "number" ||
        typeof exp !== "number" ||
        typeof jti !== "string"
      ) {
        this.#recorder.record({
          type: "renewal",
          grant_id: this.grantId,
          ok: false,
          error: "malformed_lease",
        });
        return this.#scheduleRetry(nowMs);
      }
      this.#held = {
        token: result.lease,
        jti,
        iatMs: iat * 1000,
        expMs: exp * 1000,
      };
      this.#failedAttempts = 0;
      this.#recorder.record({
        type: "renewal",
        grant_id: this.grantId,
        ok: true,
        jti,
      });
      this.#onLease(this.#held);
      this.#nextAttemptAtMs = plannedRenewalAtMs(
        this.#held.iatMs,
        this.#held.expMs,
        this.#policy,
        this.#random,
      );
      return this.#nextAttemptAtMs;
    }
    this.#recorder.record({
      type: "renewal",
      grant_id: this.grantId,
      ok: false,
      error: result.error,
    });
    if (result.terminal) {
      // "No lease" is uniform: withdrawn, revoked, expired and unknown look
      // the same. The client stops asking and lets the held lease run out.
      this.#terminal = result.error;
      return null;
    }
    return this.#scheduleRetry(nowMs);
  }

  #scheduleRetry(nowMs: number): number {
    this.#nextAttemptAtMs = nextRetryAtMs(
      nowMs,
      this.#failedAttempts,
      this.#held?.expMs ?? null,
      this.#policy,
      this.#random,
    );
    this.#failedAttempts += 1;
    return this.#nextAttemptAtMs;
  }
}
