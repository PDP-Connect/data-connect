// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scheduler back-off for chronically-failing connectors.
 *
 * Problem: when a connector enters a degraded state (e.g. Cloudflare login
 * challenge, persistent 429, missing browser surface), the scheduler keeps
 * dispatching at the configured interval. Every tick produces a fresh red
 * record on the timeline, wastes browser-surface leases, and pollutes
 * downstream telemetry. This frustrates the owner without surfacing new
 * signal — the next run will fail the same way.
 *
 * Solution: after N consecutive runs that all terminate with the same
 * reason class, exponentially delay the next dispatch. A `succeeded` run
 * (or a `skipped` run, which is not a failure) resets the counter. Manual
 * run-now bypasses back-off — the owner is asking us to retry now and
 * either the underlying issue is fixed or we want a fresh failure record
 * with current context.
 *
 * This module is **pure**: it takes recent run history + the connector's
 * configured base interval and returns a decision. No I/O, no timers, no
 * side effects. The scheduler interval loop consumes the decision.
 *
 * The decision is also intentionally minimal: it does **not** suppress the
 * failure record itself, only the *next* automatic dispatch. If the
 * connector keeps failing, the back-off window grows; if it succeeds once,
 * the counter resets.
 */

import { BLOCKED_PROMOTION_THRESHOLD } from "./connection-health-policy.ts";
import type { RunRecord, RunStatus } from "./scheduler-domain-types.ts";

// ─── Tunables ──────────────────────────────────────────────────────────────

/**
 * Number of consecutive failures with the same reason class that must occur
 * before back-off engages. Below this threshold the scheduler runs at the
 * configured base interval — we want quick recovery on transient blips.
 */
export const DEFAULT_BACKOFF_THRESHOLD = 3;

/**
 * Hard ceiling on the exponential multiplier so the back-off window doesn't
 * grow unboundedly. `2^MAX_BACKOFF_EXP` is the largest multiplier applied
 * to `baseInterval`. With the default 24h cap below this is rarely the
 * binding constraint, but it guards against absurd intervals (e.g. a
 * connector that runs every 30s exponentially backing off to centuries).
 */
export const DEFAULT_MAX_BACKOFF_EXP = 8;

/**
 * Absolute ceiling on the back-off delay (24 hours by default). Even a
 * deeply-degraded connector will be retried at least once a day so the
 * owner sees either fresh evidence the failure persists or — if conditions
 * have changed — a recovery without manual intervention.
 */
export const DEFAULT_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export interface ComputeBackoffOptions {
  /** Threshold N: consecutive failures before back-off engages. */
  readonly backoffThreshold?: number;
  /**
   * Epoch ms of the most recent GENUINELY-SUCCESSFUL run for this connector,
   * sourced from a durable cross-path projection (the spine run timeline), NOT
   * just from the records present in the `history` argument. A scheduled run
   * dispatched by the scheduler appends a `succeeded` record to its own history
   * (so the in-history walk already resets the streak), but a manual or
   * owner-triggered `controller.runNow` success bypasses the scheduler and is
   * invisible to `history`. Without this signal a connection whose only
   * successes arrive off the scheduler's own dispatch path stays pinned at a
   * stale failure streak forever (`consecutive_failures` never decrements,
   * `last_successful_at` stays null) — the live ChatGPT wedge. When this
   * timestamp is at or after the newest failure in the trailing streak, the
   * streak is broken: a genuine success has occurred since, so automation must
   * resume on the base interval rather than the inflated back-off curve.
   * `null`/`undefined`/non-finite → no external success known (legacy
   * behaviour: trust the in-history walk alone).
   */
  readonly lastSuccessAtMs?: number | null;
  /** Owner-triggered run: bypass back-off entirely. */
  readonly manual?: boolean;
  /** Max exponent applied to the base interval. */
  readonly maxBackoffExp?: number;
  /** Absolute ceiling (ms) on the back-off delay. */
  readonly maxBackoffMs?: number;
}

export interface BackoffDecision {
  /** True when scheduler should defer the next automatic dispatch. */
  readonly backoffApplied: boolean;
  /** Count of consecutive same-class failures (capped by history length). */
  readonly consecutiveFailures: number;
  /** Effective interval (ms) the scheduler should wait from `lastRunAt`. */
  readonly effectiveIntervalMs: number;
  /** ISO timestamp of when the next dispatch becomes eligible. */
  readonly nextRunAt: string;
  /** Stable identifier of the failure class, or null when not backing off. */
  readonly reasonClass: string | null;
  /**
   * Health-state recommendation for the dashboard pill when the scheduler
   * is in a back-off-engaged shape:
   *   - `"cooling_off"`  — streak is over threshold but under the
   *                        `BLOCKED_PROMOTION_THRESHOLD`; system still
   *                        retries on the back-off curve.
   *   - `"blocked"`      — streak crossed the promotion threshold; the
   *                        scheduler should stop dispatching automatic
   *                        runs entirely until the streak breaks (via
   *                        successful manual run-now) or the owner
   *                        intervenes.
   *
   * `null` when no back-off is engaged (the dashboard derives `healthy`,
   * `degraded`, `idle`, or `needs_attention` from other signals).
   */
  readonly recommendedHealthState: "blocked" | "cooling_off" | null;
}

// ─── Reason-class classifier ────────────────────────────────────────────────

/**
 * Map a run record to a stable reason-class string. Two consecutive failed
 * records with the same class are considered "the same failure pattern".
 *
 * Priority:
 *   1. `terminalReason` — the protocol-level terminal status (e.g.
 *      `authentication_error`, `grant_revoked`). Most reliable signal.
 *   2. `failureReason` — runtime-attributed failure reason (e.g.
 *      `connector_protocol_violation`).
 *   3. `connectorError.reason` — connector-authored reason string (e.g.
 *      `reddit_login_unexpected_ui`). Required so back-off engages for
 *      connectors that don't surface terminal reasons.
 *   4. Fallback to `failure_status` so a generic `failed` still groups.
 *
 * Skipped records aren't failures and never carry a class.
 */
export function reasonClassOf(record: RunRecord): string | null {
  if (record.status !== "failed") {
    return null;
  }
  if (record.terminalReason) {
    return `terminal:${record.terminalReason}`;
  }
  if (record.failureReason) {
    return `failure:${record.failureReason}`;
  }
  const connectorReason = readConnectorReason(record.connectorError);
  if (connectorReason) {
    return `connector:${connectorReason}`;
  }
  return "failure:unknown";
}

function readConnectorReason(error: RunRecord["connectorError"]): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const candidate = (error as { reason?: unknown }).reason;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return null;
}

// ─── Certified stream-scoped failure ───────────────────────────────────────

/**
 * The connector-declared `DONE.error.code` of a certified stream-scoped failure
 * (Collection Profile: DONE failed + this code + an in-scope SKIP_RESULT naming
 * each failed stream).
 */
const STREAM_COLLECTION_FAILED_CODE = "stream_collection_failed";

/** The run facts the predicate reads; a `RunRecord`, or any projection that keeps these fields. */
export type CertifiedStreamFailureEvidence = Pick<RunRecord, "status"> &
  Partial<Pick<RunRecord, "checkpointSummary" | "connectorError">>;

/**
 * True for a failed run that certified its failure as stream-scoped AND whose
 * sibling streams committed (`checkpointSummary.commit_status` is `committed`
 * or `partially_committed`; the runtime reports `not_committed` when nothing
 * moved and `disabled` when state is not persisted).
 *
 * Trust boundary: this predicate does not verify a certificate. It relies on
 * the runtime having done so. The runtime commits sibling cursors of a failed
 * DONE only when the DONE carries the code AND an in-scope SKIP_RESULT names a
 * failed stream (`runtime/index.ts`, `handleDoneClose`), so `commit_status` of
 * `committed` or `partially_committed` on a failed run is runtime evidence. The
 * code alone is only a connector-authored claim and is not enough: without the
 * commit status the run keeps counting as a failure. Callers must pass facts
 * taken from the runtime's run record, never from connector output.
 * `commit_status` is a durability fact (state was written); it does not prove
 * the source was fully collected or that any cursor moved.
 *
 * Such a run is partial progress, not a repeat of a whole-run failure: the
 * connector ran, reached the source and committed data; only the named
 * streams' cursors were withheld. Every DONE-failed run shares the streak
 * class `terminal:connector_reported_failed`, so without this check a stream
 * that fails on every run would back the source off from the 3rd run and, at
 * `BLOCKED_PROMOTION_THRESHOLD`, stop automatic dispatch of the whole source
 * while its siblings commit on every run.
 *
 * Known limits of this policy (deliberate, kept small):
 * - It reads the scheduler's own run history. A MANUAL run (`controller.runNow`)
 *   is not in that history, so a manual certified run cannot clear an already
 *   blocked streak. A manual genuine success still does, through the existing
 *   `lastSuccessAtMs` anchor. A durable, connection-scoped recovery projection
 *   shared by the counter, the dispatch governor and the transition dedup is
 *   the follow-up.
 * - Visibility does not depend on this streak. Every such run stays `failed`
 *   and reports the failed stream's SKIP_RESULT gap. `checkpoint_stalled`
 *   (after `CHECKPOINT_STALL_RUNS` withheld runs) fires only when the failed
 *   stream had staged a cursor that was then withheld. A failed stream that
 *   never stages a STATE has nothing to withhold, so no stall warning fires
 *   for it: the owner-visible signal is the failed run plus the per-run
 *   skip_result gap. A persistent warning for that shape belongs to a
 *   per-stream collection-health projection, not to the commit gate or to
 *   this back-off.
 */
export function isCertifiedStreamFailureWithCommittedSiblings(record: CertifiedStreamFailureEvidence): boolean {
  if (record.status !== "failed") {
    return false;
  }
  if ((record.connectorError as { code?: unknown } | null | undefined)?.code !== STREAM_COLLECTION_FAILED_CODE) {
    return false;
  }
  const commitStatus = record.checkpointSummary?.commit_status;
  return commitStatus === "committed" || commitStatus === "partially_committed";
}

/**
 * True for a record that ends a failure streak: a genuine success, or a failed
 * run the runtime certified as partial progress. The back-off counter, the
 * announce-once dedup cells and the persisted transition-marker lookups must
 * all use this one boundary, so the notion of "the current streak" is the same
 * everywhere. Neither kind of record is a failure that counts toward a streak;
 * only the first is a success (`isCounterResetStatus`).
 */
export function endsFailureStreak(record: CertifiedStreamFailureEvidence): boolean {
  return record.status === "succeeded" || isCertifiedStreamFailureWithCommittedSiblings(record);
}

// ─── Core helper ────────────────────────────────────────────────────────────

/**
 * Compute the next-run timestamp for a connector, applying exponential
 * back-off when its history shows N or more consecutive failures of the
 * same reason class.
 *
 * @param history          Run history for *this* connector, ordered from
 *                         oldest to newest. The function only scans from
 *                         the tail backwards and stops at the first record
 *                         that isn't a same-class failure.
 * @param baseIntervalMs   The configured scheduling interval (ms).
 * @param lastRunAtMs      Epoch ms of the most recent run. The next-run
 *                         time is computed relative to this. Pass `0` if
 *                         the connector has never run; the function will
 *                         degenerate to no back-off (`nextRunAt = now`).
 * @param options          Tunables + manual bypass.
 */
export function computeNextRunWithBackoff(
  history: readonly RunRecord[],
  baseIntervalMs: number,
  lastRunAtMs: number,
  options: ComputeBackoffOptions = {}
): BackoffDecision {
  const threshold = normalizePositiveInteger(options.backoffThreshold, DEFAULT_BACKOFF_THRESHOLD);
  const maxExp = normalizeNonNegativeInteger(options.maxBackoffExp, DEFAULT_MAX_BACKOFF_EXP);
  const maxMs = normalizeFiniteNonNegativeMs(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS);
  const normalizedBaseIntervalMs = normalizeFiniteNonNegativeMs(baseIntervalMs, 0);
  const normalizedLastRunAtMs = normalizeFiniteNonNegativeMs(lastRunAtMs, 0);
  const manual = options.manual === true;

  if (manual) {
    return {
      backoffApplied: false,
      consecutiveFailures: 0,
      effectiveIntervalMs: 0,
      nextRunAt: new Date().toISOString(),
      reasonClass: null,
      recommendedHealthState: null,
    };
  }

  const { consecutiveFailures, reasonClass, newestFailureAtMs } = countConsecutiveSameClassFailures(history);

  // Cross-path success recovery: a genuine success recorded on a path the
  // `history` argument cannot see (manual/owner `controller.runNow`) breaks the
  // streak when it is at or after the newest failure in that streak. This is
  // the same semantic as a `succeeded` record appearing in `history` (which the
  // walk above already honours), extended to successes the scheduler did not
  // itself dispatch. Without it, a connection whose only successes are manual
  // stays wedged on an inflated back-off curve forever.
  const externalSuccessAtMs = normalizeOptionalEpochMs(options.lastSuccessAtMs);
  const externalSuccessBreaksStreak =
    externalSuccessAtMs !== null && (newestFailureAtMs === null || externalSuccessAtMs >= newestFailureAtMs);
  if (externalSuccessBreaksStreak) {
    return {
      backoffApplied: false,
      consecutiveFailures: 0,
      effectiveIntervalMs: normalizedBaseIntervalMs,
      nextRunAt: toIsoTimestamp(normalizedLastRunAtMs + normalizedBaseIntervalMs),
      reasonClass: null,
      recommendedHealthState: null,
    };
  }

  if (consecutiveFailures < threshold || reasonClass === null) {
    return {
      backoffApplied: false,
      consecutiveFailures,
      effectiveIntervalMs: normalizedBaseIntervalMs,
      nextRunAt: toIsoTimestamp(normalizedLastRunAtMs + normalizedBaseIntervalMs),
      reasonClass: consecutiveFailures > 0 ? reasonClass : null,
      recommendedHealthState: null,
    };
  }

  // consecutiveFailures >= threshold: multiplier doubles past the threshold.
  // First over-threshold failure (= threshold) yields 2^0 = 1x base interval,
  // then 2^1=2x, 2^2=4x, ...
  const exponent = Math.min(consecutiveFailures - threshold, maxExp);
  const rawDelay = normalizedBaseIntervalMs * 2 ** exponent;
  const effectiveIntervalMs = Math.min(rawDelay, maxMs);

  // Promote `cooling_off` → `blocked` once the streak has crossed the
  // ceiling. Worker C's curve plateaus at the 24h cap, so a connector
  // hitting `consecutiveFailures = BLOCKED_PROMOTION_THRESHOLD` has been
  // failing daily for at least a week — it is not "cooling off", it is
  // broken. See brief §1.3.
  const recommendedHealthState: "blocked" | "cooling_off" =
    consecutiveFailures >= BLOCKED_PROMOTION_THRESHOLD ? "blocked" : "cooling_off";

  return {
    backoffApplied: true,
    consecutiveFailures,
    effectiveIntervalMs,
    nextRunAt: toIsoTimestamp(normalizedLastRunAtMs + effectiveIntervalMs),
    reasonClass,
    recommendedHealthState,
  };
}

function normalizeFiniteNonNegativeMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function toIsoTimestamp(epochMs: number): string {
  const safeEpochMs = normalizeFiniteNonNegativeMs(epochMs, 0);
  return new Date(safeEpochMs).toISOString();
}

function countConsecutiveSameClassFailures(history: readonly RunRecord[]): {
  consecutiveFailures: number;
  reasonClass: string | null;
  /**
   * Epoch ms of the NEWEST failure in the trailing streak (the first failure
   * encountered when walking newest→oldest), or `null` when there is no streak.
   * Lets the caller compare an out-of-history success timestamp against the
   * streak to decide whether a genuine success has occurred since.
   */
  newestFailureAtMs: number | null;
} {
  let consecutiveFailures = 0;
  let reasonClass: string | null = null;
  let newestFailureAtMs: number | null = null;

  // Walk newest -> oldest until we hit a non-failure or a different class.
  // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i];
    if (!record) {
      continue;
    }
    if (record.status === "succeeded") {
      // Success resets the counter, full stop.
      break;
    }
    if (record.status !== "failed") {
      // Skipped records are not failures and not successes — they neither
      // reset nor extend the streak. Skip past them.
      continue;
    }
    if (isCertifiedStreamFailureWithCommittedSiblings(record)) {
      // Not counted, and it ends the streak (it is not transparent like a
      // `skipped` record). The runtime certified that this run reached the
      // source and committed sibling streams. That is progress, and progress
      // warrants resetting a connection-wide streak: with a transparent record
      // the stale streak stays live for as long as the failed stream keeps
      // failing. It does not prove that every older root cause is gone; a
      // genuine failure after it starts a new streak at 1.
      // This is a streak reset only. It is NOT a success: `status` stays
      // `failed`, `last_success_at` and health `CollectionSucceeded` are
      // untouched, and `isCounterResetStatus` is unchanged. The dedup of
      // `back_off.started` / `gave_up` uses the same boundary (`endsFailureStreak`).
      break;
    }
    const candidate = reasonClassOf(record);
    if (candidate === null) {
      // Defensive: a failed record with no class shouldn't happen, but if
      // it does treat it as a different class and stop counting.
      break;
    }
    if (reasonClass === null) {
      reasonClass = candidate;
    } else if (candidate !== reasonClass) {
      break;
    }
    if (newestFailureAtMs === null) {
      // First (newest) failure of the streak anchors the recovery comparison.
      newestFailureAtMs = recordTimestampMs(record);
    }
    // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
    consecutiveFailures++;
  }

  return { consecutiveFailures, newestFailureAtMs, reasonClass };
}

/**
 * Best-effort epoch-ms timestamp for a run record, preferring `completedAt`
 * (when the run settled) and falling back to `startedAt`. Returns `null` when
 * neither parses to a finite epoch.
 */
function recordTimestampMs(record: RunRecord): number | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const completed = Date.parse(record.completedAt ?? "");
  if (Number.isFinite(completed)) {
    return completed;
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const started = Date.parse(record.startedAt ?? "");
  return Number.isFinite(started) ? started : null;
}

/**
 * Normalize an optional epoch-ms input to a finite non-negative number or
 * `null`. Mirrors the defensive timing normalization used elsewhere in this
 * module so a malformed projection can never throw or invert the comparison.
 */
function normalizeOptionalEpochMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

// ─── Run-status helper ─────────────────────────────────────────────────────

/**
 * Boolean version of "did this record reset the back-off counter?". Useful
 * for callers that want to clear sticky back-off state after a success.
 */
export function isCounterResetStatus(status: RunStatus): boolean {
  return status === "succeeded";
}

