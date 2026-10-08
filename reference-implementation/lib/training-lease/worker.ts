/**
 * Worker-side lease enforcement (lease note L7, L8, L9, L11).
 *
 * A worker, or a trusted enforcement component in front of it, validates each
 * owner's lease against the authenticated lineage of the inputs, then turns
 * the lease `exp` into a stop deadline on the monotonic clock. Admission of
 * that owner's examples closes early enough that queued and in-flight steps
 * finish before the deadline.
 *
 * Every time source is injected, so tests drive expiry, suspension and clock
 * rollback without real waits.
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */
import {
  AI_TRAINING_PERMISSION,
  LEASE_JWS_TYP,
  MAX_LEASE_LIFETIME_MS,
} from "./constants.ts";
import {
  decodeCompactJws,
  type OkpPublicJwk,
  verifyDecodedJws,
} from "./jws.ts";

export interface TrustedTimeReading {
  /** Best estimate of true UTC time, in ms since the epoch. */
  nowMs: number;
  /** Half-width of the error bound: true time is in [nowMs - u, nowMs + u]. */
  uncertaintyMs: number;
}

export interface WorkerClock {
  /** Never decreases within one process. May stall while the host is suspended. */
  monotonicMs(): number;
  /** A bounded trusted-time source, or null when none is available. */
  trustedTime(): TrustedTimeReading | null;
}

export interface Jwks {
  keys: Array<OkpPublicJwk & { kid: string }>;
}

/** The authenticated origin of an owner's inputs (Core: issuer, grant, client bindings). */
export interface InputLineage {
  iss: string;
  grantId: string;
  clientId: string;
  /**
   * Held-data prototype (B3): the grant the input copy was acquired under,
   * when it differs from the training grant. The lease must name it.
   */
  acquisitionGrantId?: string;
}

export interface LeaseClaims {
  iss: string;
  aud: string;
  jti: string;
  grant_id: string;
  permission: string;
  iat: number;
  exp: number;
  /** B3: acquisition grants whose copies the lease covers. */
  acq?: string[];
}

export type LeaseRejection =
  | "malformed"
  | "wrong_typ"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_permission"
  | "wrong_grant"
  | "acquisition_not_covered"
  | "lifetime_exceeds_profile"
  | "expired"
  | "no_trusted_time"
  | "clock_uncertain"
  | "clock_rollback";

export type LeaseValidation =
  | { ok: true; claims: LeaseClaims; kid: string }
  | { ok: false; reason: LeaseRejection };

export function lineageKey(lineage: InputLineage): string {
  const base = `${lineage.iss} ${lineage.clientId} ${lineage.grantId}`;
  return lineage.acquisitionGrantId === undefined ? base : `${base} ${lineage.acquisitionGrantId}`;
}

/**
 * Signature and claim checks that do not depend on time. The caller supplies
 * the lineage it authenticated for the inputs; the lease must match it.
 */
export function validateLeaseStatic(
  token: string,
  jwks: Jwks,
  lineage: InputLineage,
): LeaseValidation {
  const decoded = decodeCompactJws(token);
  if (!decoded) {
    return { ok: false, reason: "malformed" };
  }
  if (decoded.header.typ !== LEASE_JWS_TYP) {
    return { ok: false, reason: "wrong_typ" };
  }
  const kid = decoded.header.kid;
  if (typeof kid !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const key = jwks.keys.find((k) => k.kid === kid);
  if (!key) {
    return { ok: false, reason: "unknown_key" };
  }
  if (!verifyDecodedJws(decoded, key)) {
    return { ok: false, reason: "bad_signature" };
  }
  const p = decoded.payload;
  if (
    typeof p.iss !== "string" ||
    typeof p.aud !== "string" ||
    typeof p.jti !== "string" ||
    typeof p.grant_id !== "string" ||
    typeof p.permission !== "string" ||
    typeof p.iat !== "number" ||
    typeof p.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  const claims = p as unknown as LeaseClaims;
  if (claims.iss !== lineage.iss) {
    return { ok: false, reason: "wrong_issuer" };
  }
  if (claims.aud !== lineage.clientId) {
    return { ok: false, reason: "wrong_audience" };
  }
  if (claims.permission !== AI_TRAINING_PERMISSION) {
    return { ok: false, reason: "wrong_permission" };
  }
  if (claims.grant_id !== lineage.grantId) {
    return { ok: false, reason: "wrong_grant" };
  }
  if (
    lineage.acquisitionGrantId !== undefined &&
    lineage.acquisitionGrantId !== lineage.grantId &&
    !(Array.isArray(claims.acq) && claims.acq.includes(lineage.acquisitionGrantId))
  ) {
    return { ok: false, reason: "acquisition_not_covered" };
  }
  if ((claims.exp - claims.iat) * 1000 > MAX_LEASE_LIFETIME_MS) {
    return { ok: false, reason: "lifetime_exceeds_profile" };
  }
  return { ok: true, claims, kid };
}

/** L11 job record entries. */
export type JobRecordEvent =
  | {
      type: "lease_relied";
      jti: string;
      grant_id: string;
      exp: number;
      kid: string;
      clock_margin_ms: number;
    }
  | { type: "lease_rejected"; grant_id: string; reason: LeaseRejection }
  | {
      type: "renewal";
      grant_id: string;
      ok: boolean;
      jti?: string;
      error?: string;
    }
  | {
      type: "admission_stopped";
      grant_id: string;
      reason: string;
      deadline_trusted_ms: number | null;
    }
  | { type: "drained"; grant_id: string; examples_dropped: number }
  | { type: "step_aborted"; grant_ids: string[]; reason: string }
  | { type: "job_paused"; grant_id: string; reason: string }
  | { type: "revalidation_required"; grant_id: string; reason: string }
  | { type: "authority_ended"; grant_id: string; reason: string };

export class JobRecorder {
  readonly events: Array<JobRecordEvent & { at_trusted_ms: number | null }> =
    [];
  readonly #clock: WorkerClock;

  constructor(clock: WorkerClock) {
    this.#clock = clock;
  }

  record(event: JobRecordEvent): void {
    this.events.push({
      ...event,
      at_trusted_ms: this.#clock.trustedTime()?.nowMs ?? null,
    });
  }

  ofType<T extends JobRecordEvent["type"]>(
    type: T,
  ): Array<Extract<JobRecordEvent, { type: T }>> {
    return this.events.filter((e) => e.type === type) as unknown as Array<
      Extract<JobRecordEvent, { type: T }>
    >;
  }
}

export interface AuthorityGuardOptions {
  /** Fail closed when trusted-time uncertainty exceeds this. */
  maxClockUncertaintyMs: number;
  /** Longest time queued plus in-flight steps for this owner can take. */
  drainMs: number;
  /** Extra margin subtracted from every deadline. */
  safetyMarginMs: number;
  /**
   * Slack allowed between trusted elapsed time and monotonic elapsed time
   * before the guard treats the gap as an unobserved suspension.
   */
  suspendDetectionSlackMs: number;
}

export const DEFAULT_GUARD_OPTIONS: AuthorityGuardOptions = {
  maxClockUncertaintyMs: 5000,
  drainMs: 5 * 60 * 1000,
  safetyMarginMs: 1000,
  suspendDetectionSlackMs: 2000,
};

/** Persisted with checkpoints. Holds no authority; only the time high-water mark. */
export interface GuardCheckpoint {
  grant_id: string;
  /** Highest trusted time the guard has observed, to detect rollback after restart. */
  trusted_high_water_ms: number;
  /** jtis already relied on. Informational; a restored checkpoint never restores authority. */
  relied_jtis: string[];
}

/**
 * Per-grant authority as one worker sees it. Holds the deadline in monotonic
 * time. Nothing here can make the deadline later than the lease allows:
 * a checkpoint carries no authority, and every resume needs a fresh lease
 * validation against trusted time.
 */
export class GrantAuthorityGuard {
  readonly lineage: InputLineage;
  readonly #clock: WorkerClock;
  readonly #opts: AuthorityGuardOptions;
  readonly #recorder: JobRecorder;
  #deadlineMono: number | null = null;
  #deadlineTrustedMs: number | null = null;
  #needsRevalidation = false;
  #ended: string | null = null;
  #lastAnchor: { mono: number; trusted: TrustedTimeReading } | null = null;
  #trustedHighWaterMs = Number.NEGATIVE_INFINITY;
  #reliedKid: string | null = null;
  readonly #reliedJtis = new Set<string>();

  constructor(
    lineage: InputLineage,
    clock: WorkerClock,
    recorder: JobRecorder,
    opts: Partial<AuthorityGuardOptions> = {},
  ) {
    this.lineage = lineage;
    this.#clock = clock;
    this.#recorder = recorder;
    this.#opts = { ...DEFAULT_GUARD_OPTIONS, ...opts };
  }

  get grantId(): string {
    return this.lineage.grantId;
  }

  /** Deadline as trusted wall time, for records and the owner-facing stop time. */
  get deadlineTrustedMs(): number | null {
    return this.#deadlineTrustedMs;
  }

  /** Restore a checkpoint. Only the rollback high-water mark is carried over. */
  restoreCheckpoint(cp: GuardCheckpoint): void {
    if (cp.grant_id !== this.lineage.grantId) {
      throw new Error("checkpoint is for another grant");
    }
    this.#trustedHighWaterMs = Math.max(
      this.#trustedHighWaterMs,
      cp.trusted_high_water_ms,
    );
    for (const jti of cp.relied_jtis) {
      this.#reliedJtis.add(jti);
    }
    this.#needsRevalidation = true;
  }

  checkpoint(): GuardCheckpoint {
    return {
      grant_id: this.lineage.grantId,
      trusted_high_water_ms: this.#trustedHighWaterMs,
      relied_jtis: [...this.#reliedJtis],
    };
  }

  /**
   * Validate a lease and (re)compute the deadline. A lease that would move the
   * deadline later is accepted only with a fresh trusted-time reading.
   */
  accept(token: string, jwks: Jwks): LeaseValidation {
    if (this.#ended) {
      return { ok: false, reason: "expired" };
    }
    const v = validateLeaseStatic(token, jwks, this.lineage);
    if (!v.ok) {
      this.#recorder.record({
        type: "lease_rejected",
        grant_id: this.lineage.grantId,
        reason: v.reason,
      });
      return v;
    }
    const trusted = this.#clock.trustedTime();
    const mono = this.#clock.monotonicMs();
    const timeFailure = this.#checkTrustedTime(trusted);
    if (timeFailure) {
      this.#recorder.record({
        type: "lease_rejected",
        grant_id: this.lineage.grantId,
        reason: timeFailure,
      });
      return { ok: false, reason: timeFailure };
    }
    const t = trusted as TrustedTimeReading;
    // Assume the latest time the bound allows, so the deadline is conservative.
    const remaining =
      v.claims.exp * 1000 -
      (t.nowMs + t.uncertaintyMs) -
      this.#opts.safetyMarginMs;
    if (remaining <= 0) {
      this.#recorder.record({
        type: "lease_rejected",
        grant_id: this.lineage.grantId,
        reason: "expired",
      });
      return { ok: false, reason: "expired" };
    }
    // The deadline comes only from this lease and this trusted reading. A
    // rolled-back clock cannot extend it: #checkTrustedTime refused readings
    // below the high-water mark.
    this.#deadlineMono = mono + remaining;
    this.#deadlineTrustedMs = t.nowMs + t.uncertaintyMs + remaining;
    this.#lastAnchor = { mono, trusted: t };
    this.#needsRevalidation = false;
    this.#reliedKid = v.kid;
    this.#reliedJtis.add(v.claims.jti);
    this.#recorder.record({
      type: "lease_relied",
      jti: v.claims.jti,
      grant_id: v.claims.grant_id,
      exp: v.claims.exp,
      kid: v.kid,
      clock_margin_ms: t.uncertaintyMs + this.#opts.safetyMarginMs,
    });
    return v;
  }

  #checkTrustedTime(trusted: TrustedTimeReading | null): LeaseRejection | null {
    if (!trusted) {
      return "no_trusted_time";
    }
    if (trusted.uncertaintyMs > this.#opts.maxClockUncertaintyMs) {
      return "clock_uncertain";
    }
    if (
      trusted.nowMs + trusted.uncertaintyMs <
      this.#trustedHighWaterMs - this.#opts.suspendDetectionSlackMs
    ) {
      return "clock_rollback";
    }
    this.#trustedHighWaterMs = Math.max(
      this.#trustedHighWaterMs,
      trusted.nowMs - trusted.uncertaintyMs,
    );
    return null;
  }

  /** Host signals a resume (process restart, SIGCONT, VM resume, checkpoint load). */
  onResume(): void {
    this.#needsRevalidation = true;
    this.#recorder.record({
      type: "revalidation_required",
      grant_id: this.lineage.grantId,
      reason: "resume",
    });
  }

  /** L9: a refreshed JWKS that no longer lists the relied-on key ends authority now. */
  onJwksRefreshed(jwks: Jwks): void {
    if (this.#reliedKid && !jwks.keys.some((k) => k.kid === this.#reliedKid)) {
      this.end("signing_key_withdrawn");
    }
  }

  end(reason: string): void {
    if (this.#ended) {
      return;
    }
    this.#ended = reason;
    this.#deadlineMono = null;
    this.#recorder.record({
      type: "authority_ended",
      grant_id: this.lineage.grantId,
      reason,
    });
  }

  /**
   * Detect an unobserved suspension: trusted time advanced further than the
   * monotonic clock did since the anchor. CLOCK_MONOTONIC on Linux stops
   * during system suspend, so a monotonic-only deadline would be extended by
   * the suspend duration.
   */
  #detectStall(): boolean {
    if (!this.#lastAnchor) {
      return false;
    }
    const t = this.#clock.trustedTime();
    if (!t) {
      return false;
    }
    const monoElapsed = this.#clock.monotonicMs() - this.#lastAnchor.mono;
    const trustedElapsed = t.nowMs - this.#lastAnchor.trusted.nowMs;
    const slack =
      t.uncertaintyMs +
      this.#lastAnchor.trusted.uncertaintyMs +
      this.#opts.suspendDetectionSlackMs;
    if (trustedElapsed - monoElapsed > slack) {
      this.#needsRevalidation = true;
      this.#recorder.record({
        type: "revalidation_required",
        grant_id: this.lineage.grantId,
        reason: "monotonic_stall_detected",
      });
      return true;
    }
    return false;
  }

  /** Remaining authority in ms (monotonic). Negative or null means none. */
  remainingMs(): number | null {
    if (this.#ended || this.#deadlineMono === null || this.#needsRevalidation) {
      return null;
    }
    if (this.#detectStall()) {
      return null;
    }
    return this.#deadlineMono - this.#clock.monotonicMs();
  }

  /** May new examples of this owner enter the queue? Closes `drainMs` early. */
  canAdmit(): { ok: true } | { ok: false; reason: string } {
    const r = this.remainingMs();
    if (r === null) {
      return {
        ok: false,
        reason: this.#ended ?? "no_valid_lease_or_revalidation_required",
      };
    }
    if (r <= this.#opts.drainMs) {
      return { ok: false, reason: "admission_window_closed" };
    }
    return { ok: true };
  }

  /** May a step that includes this owner's examples start, given its worst-case duration? */
  canStartStep(worstCaseStepMs: number): boolean {
    const r = this.remainingMs();
    return r !== null && r > worstCaseStepMs;
  }
}
