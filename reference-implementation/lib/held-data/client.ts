// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side held-data lifecycle (Core v0.1.0: Held data, Erasure, Retention).
 *
 * The client keeps, per grant whose data it holds:
 * - whether it holds a positive assessment, which first use needs and which
 *   AS silence never withdraws;
 * - the erasure instructions it has received, each with its stop-use bound
 *   (from the effective time) and its deletion deadline (from first
 *   authenticated receipt);
 * - the first-acquisition time, which no reread or transform moves;
 * - legal retention it declared for data an instruction covers.
 *
 * `canUse` is the gate the app checks before every use. `tick` attempts
 * lifecycle queries on schedule and disposes of anything overdue. All time
 * comes from the injected clock.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import { z } from "zod";
import type { ErasureScope, StatusAnswer, StatusResult } from "./authority.ts";
import { type ClientCheckpointStorage, MemoryClientCheckpointStorage } from "./checkpoint.ts";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** Core stop-use bound: the longest time from an instruction's effective time to the end of use. */
export const STOP_USE_BOUND_MS = 48 * HOUR_MS;

export interface LifecyclePolicy {
  /** Reconciliation interval: attempt a query at least this often while any covered data is held. */
  cadenceMs: number;
  /** Retry interval: the next attempt starts within this of the preceding attempt's start. */
  retryMs: number;
  /** Delete within this period of first authenticated receipt. */
  deletionPeriodMs: number;
  /** Retention ceiling from first acquisition. Null: no stated limit. */
  retentionCeilingMs: number | null;
  /** When the app disposes of data under an instruction: at once, or at the latest permitted time. */
  disposeAt: "promptly" | "deadline";
}

export const DEFAULT_POLICY: LifecyclePolicy = {
  cadenceMs: DAY_MS,
  retryMs: HOUR_MS,
  deletionPeriodMs: 30 * DAY_MS,
  retentionCeilingMs: null,
  disposeAt: "promptly",
};

/**
 * Core retention `max_duration` is day-only `PnD` (n a positive whole number; a day is 24 h).
 * Anything else (months, years, weeks, time parts) is not a duration the client can count in
 * elapsed time: null.
 */
export function parseRetentionDays(value: unknown): number | null {
  const m = typeof value === "string" ? /^P(\d+)D$/.exec(value) : null;
  const days = m ? Number(m[1]) : Number.NaN;
  return Number.isSafeInteger(days) && days > 0 && Number.isSafeInteger(days * DAY_MS) ? days * DAY_MS : null;
}

/** End of a legal-retention obligation: a date, an event or condition, or unknown. Never an invented date. */
export type RetentionEnd = { kind: "date"; at: number } | { kind: "event"; text: string } | { kind: "unknown" };

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** Parse the wire form of `retained_until`: RFC 3339 date-time, `event:<non-empty text>`, or `unknown`. */
export function parseRetentionEnd(value: unknown): RetentionEnd | null {
  if (typeof value !== "string") return null;
  if (value === "unknown") return { kind: "unknown" };
  if (value.startsWith("event:")) {
    const text = value.slice("event:".length);
    return text.trim() === "" ? null : { kind: "event", text };
  }
  const at = RFC3339.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? { kind: "date", at } : null;
}

export function formatRetentionEnd(end: RetentionEnd): string {
  return end.kind === "date" ? new Date(end.at).toISOString() : end.kind === "event" ? `event:${end.text}` : "unknown";
}

export type StatusTransport = (
  grantIds: readonly string[],
) => Promise<
  | { ok: true; results: StatusResult[] }
  /** `retryAfterMs`: a server-directed wait (HTTP 429 or 503 `Retry-After`). */
  | { ok: false; reason: string; retryAfterMs?: number }
>;

/** Client writes (receipt, completion, retained). Need current client authentication. */
export type ReportTransport = (r: {
  grantId: string;
  operationId: string;
  kind: "receipt" | "completion" | "retained";
  outcome?: "deleted" | "exception";
  /** Client time of the event: first receipt, completion, or the end of deletion apart from retained data. */
  reportedAt?: number;
  /** With `retained`: the end of the legal obligation, in one of its three forms. */
  retainedUntil?: RetentionEnd;
  /** With `retained`: sent unless law prohibits it. */
  retentionBasis?: string;
  retentionScope?: string;
}) => Promise<boolean>;

/** Data a legal obligation requires the client to keep after an erasure instruction (Core: Legal retention). */
export interface LegalRetentionSpec {
  /** Which covered data is kept. */
  scope: string;
  /** The legal basis. */
  basis: string;
  end: RetentionEnd;
  /** The records kept. The client deletes every other covered record. */
  records: readonly HeldRecordRef[];
  /** The processing the obligation requires. The client allows no other processing of the retained data. */
  requiredProcessing?: readonly string[];
  /** Law prohibits the report, or the basis or the scope in it. */
  lawProhibits?: { report?: boolean; basis?: boolean; scope?: boolean };
}

interface LegalRetention {
  scope: string;
  basis: string;
  end: RetentionEnd;
  records: HeldRecordRef[];
  requiredProcessing: string[];
  lawProhibits: { report: boolean; basis: boolean; scope: boolean };
  recordedAt: number;
  /** When the obligation ended and the client deleted the retained data. */
  endedAt: number | null;
  reported: boolean;
}

/** Acquisition identity and, when known, the delivered record version. */
export interface HeldRecordRef {
  id: string;
  stream: string;
  sourceId?: string;
  instanceId?: string;
  version?: string;
}

interface HeldRecord {
  ref: HeldRecordRef;
  firstAcquiredAt: number;
}

/** Where the app keeps the copy and its derivatives. */
export interface HeldStore {
  /** Inventory includes derivatives: lost lifecycle state makes all these copies due. */
  grantIds(): Iterable<string>;
  /**
   * Complete inventory of the grant's held records. Required for per-record retention: it migrates
   * a legacy acquisition and finds records that a restored data backup brings back.
   */
  recordRefs?(grantId: string): Iterable<HeldRecordRef>;
  /** Remove the covered records and every derivative built from them. */
  dispose(grantId: string, scope: ErasureScope): void;
  /** Remove these versions and delete or regenerate every derivative that used them. */
  disposeRecords?(grantId: string, records: readonly HeldRecordRef[]): void;
}

/** What a downstream holder receives. Absolute times only. */
export interface DownstreamNotice {
  grantId: string;
  /** Client time the notice was issued, so a holder can order reordered deliveries. */
  issuedAt?: number;
  /** The client permits use of the data at the time of the notice. */
  usable?: boolean;
  /** The earliest known deadline that ends use unless a later notice extends it. Null: none known. */
  useUntil: number | null;
  /** Erasures, each with its original absolute deadlines. */
  erasures: { operationId: string; scope: ErasureScope; deleteBy: number; effectiveAt?: number; stopUseBy?: number }[];
  deleteAllBy: number | null;
}

export interface Downstream {
  relay(n: DownstreamNotice): void;
}

export type UseDecision =
  /** `until`: the earliest known deadline that ends use (retention ceiling or deletion), if any. */
  | { ok: true; until: number | null }
  | {
      ok: false;
      reason: "deleted" | "erased" | "no_assessment" | "reconcile_required" | "custody_only" | "state_unavailable" | "disposal_due";
    };

interface HeldErasure {
  scope: ErasureScope;
  /** First authenticated receipt, or the owner's `delete` choice in the client. */
  receivedAt: number;
  deleteBy: number;
  /** Effective time of the instruction, never later than receipt (a client cannot learn it before it applies). */
  effectiveAt: number;
  /** Effective time plus the stop-use bound. */
  stopUseBy: number;
  /** When use stopped: the client stops at once on learning. */
  stoppedUseAt: number;
  /** The client learned of the instruction after the stop-use bound. */
  learnedLate: boolean;
  disposedAt: number | null;
  /** Disposal finished after the deletion deadline: the missed deadline stays on record. */
  overdue: boolean;
  receiptReported: boolean;
  completionReported: boolean;
  disposalPending: boolean;
  retained: LegalRetention | null;
}

interface HeldGrant {
  grantId: string;
  readState: StatusAnswer["grant_state"];
  firstAcquiredAt: number;
  /** Client send time of the latest positive assessment. First use needs one; silence never withdraws it. */
  positiveAt: number | null;
  custodyOnly: boolean;
  /** Known locally: the grant carries a processing permission, so it has no surviving use. */
  processingPermission: boolean;
  lastPosition: number;
  erasures: Map<string, HeldErasure>;
  deletedAt: number | null;
  deleteReason: string | null;
  /** An attempt must START before further use (failure-triggered, or resumed after one fell due). */
  needsReconcile: boolean;
  /** Start of the latest lifecycle query attempt (a token response that returns the grant counts). */
  lastAttemptStartAt: number | null;
  /** Latest time the next attempt may start. Null: none owed. */
  nextAttemptAt: number | null;
  pendingDeletionReason: string | null;
  recordsTracked: boolean;
  legacyAcquiredAt: number | null;
  /**
   * Earliest first-acquisition time of a legacy copy whose records can no longer be listed (it was
   * disposed, or the store showed nothing). Records delivered later cannot be told from it, so each
   * counts from this time and never from its own delivery (Core: never restarts that clock).
   */
  legacyFloorAt: number | null;
  records: Map<string, HeldRecord>;
}

function sameRef(a: HeldRecordRef, b: HeldRecordRef): boolean {
  return a.sourceId === b.sourceId && a.instanceId === b.instanceId && a.id === b.id && a.stream === b.stream && a.version === b.version;
}

/** The earliest of the known times, or null if none is known. */
function earliest(...times: (number | null | undefined)[]): number | null {
  const known = times.filter((x): x is number => x !== null && x !== undefined);
  return known.length ? Math.min(...known) : null;
}

const time = z.number().finite();
const interval = time.nonnegative();
const refSchema = z.object({
  id: z.string(), stream: z.string(), sourceId: z.string().optional(), instanceId: z.string().optional(),
  version: z.string().optional(),
}).transform((ref): HeldRecordRef => ({
  id: ref.id, stream: ref.stream,
  ...(ref.sourceId === undefined ? {} : { sourceId: ref.sourceId }),
  ...(ref.instanceId === undefined ? {} : { instanceId: ref.instanceId }),
  ...(ref.version === undefined ? {} : { version: ref.version }),
}));
// Older checkpoints also carry the removed pause threshold, long-stop and freshness origin. The
// schema ignores them: they were limits on use, and Core v0.1.0 has none.
const policySchema = z.object({
  cadenceMs: interval, retryMs: interval, deletionPeriodMs: interval,
  retentionCeilingMs: interval.nullable(), disposeAt: z.enum(["promptly", "deadline"]),
});
const retentionEndSchema = z.union([
  z.object({ kind: z.literal("date"), at: time }),
  z.object({ kind: z.literal("event"), text: z.string().min(1) }),
  z.object({ kind: z.literal("unknown") }),
]);
const legalRetentionSchema = z.object({
  scope: z.string(), basis: z.string(), end: retentionEndSchema, records: z.array(refSchema),
  requiredProcessing: z.array(z.string()),
  lawProhibits: z.object({ report: z.boolean(), basis: z.boolean(), scope: z.boolean() }),
  recordedAt: time, endedAt: time.nullable(), reported: z.boolean(),
});
// Version 1 is readable: its pause and long-stop fields are ignored, `freshnessOrigin` reads as the
// positive assessment, and its single schedule seeds each held grant's own.
const checkpointSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), revision: z.number().int().nonnegative(), policy: policySchema,
  highWaterMs: time, clockUncertain: z.boolean(), nextAttemptAt: time.nullable().optional(),
  tokenOrigins: z.array(z.tuple([z.string(), z.object({ origin: time, processingPermission: z.boolean() })])),
  tokenRequests: z.array(z.tuple([z.string(), time])),
  // [record identity, [[version or null (unknown/ambiguous), first acquisition time]]]
  acquisitions: z.array(z.tuple([z.string(), z.array(z.tuple([z.string().nullable(), time]))])).optional(),
  grants: z.array(z.object({
    grantId: z.string(), firstAcquiredAt: time, custodyOnly: z.boolean(),
    freshnessOrigin: time.nullable().optional(),
    positiveAt: time.nullable().optional(),
    lastAttemptStartAt: time.nullable().optional(),
    nextAttemptAt: time.nullable().optional(),
    processingPermission: z.boolean(), lastPosition: z.number().int().nonnegative(),
    deletedAt: time.nullable(), deleteReason: z.string().nullable(), needsReconcile: z.boolean(),
    pendingDeletionReason: z.string().nullable(),
    // Added with per-record retention. Absent in older checkpoints: restored as untracked, so the
    // grant-level ceiling (never later than the record clocks) applies.
    readState: z.enum(["active", "window_closed", "expired", "ended"]).optional(),
    recordsTracked: z.boolean().optional(),
    legacyAcquiredAt: time.nullable().optional(),
    legacyFloorAt: time.nullable().optional(),
    records: z.array(z.tuple([z.string(), z.object({ ref: refSchema, firstAcquiredAt: time })])).optional(),
    erasures: z.array(z.tuple([z.string(), z.object({
      scope: z.object({ streams: z.union([z.literal("all"), z.array(z.string())]) }),
      receivedAt: time, deleteBy: time, disposedAt: time.nullable(), receiptReported: z.boolean(),
      completionReported: z.boolean(), disposalPending: z.boolean(),
      // Added with the stop-use bound and legal retention. Older checkpoints: effective at receipt.
      effectiveAt: time.optional(), stopUseBy: time.optional(), stoppedUseAt: time.optional(),
      learnedLate: z.boolean().optional(), overdue: z.boolean().optional(),
      retained: legalRetentionSchema.nullable().optional(),
    })])),
  })),
});

export interface LifecycleEvent {
  at: number;
  grantId: string;
  kind: "acquire" | "positive" | "erasure_received" | "disposed" | "status_failed" | "ignored_stale_answer";
  detail?: string;
}

export class HeldDataClient {
  readonly policy: LifecyclePolicy;
  readonly #now: () => number;
  readonly #status: StatusTransport;
  readonly #report: ReportTransport | null;
  readonly #store: HeldStore;
  readonly #downstream: Downstream[];
  readonly #grants = new Map<string, HeldGrant>();
  readonly #batch: boolean;
  readonly #storage: ClientCheckpointStorage;
  readonly #tokenOrigins = new Map<string, { origin: number; processingPermission: boolean }>();
  readonly #tokenRequests = new Map<string, number>();
  readonly #legalRetention: ((q: { grantId: string; operationId: string; scope: ErasureScope }) => LegalRetentionSpec | null) | null;
  #revision = 0;
  #highWaterMs: number;
  #clockUncertain = false;
  #stateUnavailable = false;
  #timeAnchor: { wall: number; mono: number } | null = null;
  /** Acquisition clocks survive grant changes and disposal; versions share identity only when ambiguous. */
  readonly #acquisitions = new Map<string, Map<string | undefined, number>>();
  readonly events: LifecycleEvent[] = [];

  constructor(o: {
    /** Caller supplies conservative epoch time; wall time alone is not a trusted time service. */
    now: () => number;
    status: StatusTransport;
    report?: ReportTransport;
    store: HeldStore;
    downstream?: Downstream[];
    policy?: Partial<LifecyclePolicy>;
    /**
     * The grant's retention `max_duration`, which must be day-only `PnD`. A value of any other form
     * is not a ceiling the client can count, so it cannot show that a disposal deadline lies ahead:
     * the ceiling is taken as already reached and the client keeps nothing under it (Core: if it
     * cannot establish that a disposal deadline remains in the future, treat disposal as due).
     */
    retentionMaxDuration?: string;
    /**
     * Legal retention the client's law requires for data an erasure instruction covers. Asked when
     * the instruction's data becomes due for deletion, before anything is deleted.
     */
    legalRetention?: (q: { grantId: string; operationId: string; scope: ErasureScope }) => LegalRetentionSpec | null;
    /** Confidential clients may ask about several grants in one call. */
    batch?: boolean;
    storage?: ClientCheckpointStorage;
    /** Explicitly initialize a pristine store; never use this when restoring held data. */
    initialize?: boolean;
    /** Like the lease guard: optionally detect wall/elapsed disagreement and suspension. */
    monotonicMs?: () => number;
  }) {
    this.policy = { ...DEFAULT_POLICY, ...o.policy };
    if (o.retentionMaxDuration !== undefined) {
      this.policy.retentionCeilingMs = parseRetentionDays(o.retentionMaxDuration) ?? 0;
    }
    this.#legalRetention = o.legalRetention ?? null;
    this.#highWaterMs = o.now();
    this.#now = () => this.#readTime(o.now(), o.monotonicMs?.());
    this.#status = o.status;
    this.#report = o.report ?? null;
    this.#store = o.store;
    this.#downstream = o.downstream ?? [];
    this.#batch = o.batch ?? false;
    this.#storage = o.storage ?? new MemoryClientCheckpointStorage();
    try {
      const raw = this.#storage.read();
      if (raw === null) {
        if ((o.initialize ?? o.storage === undefined) && [...o.store.grantIds()].length === 0) {
          this.#persist();
        } else {
          this.#stateUnavailable = true;
        }
      } else {
        const cp = checkpointSchema.parse(JSON.parse(raw));
        this.policy = { ...DEFAULT_POLICY, ...cp.policy };
        this.#revision = cp.revision;
        this.#highWaterMs = cp.highWaterMs;
        this.#clockUncertain = cp.clockUncertain;
        for (const [id, origin] of cp.tokenOrigins) {
          this.#tokenOrigins.set(id, origin);
        }
        for (const [id, sentAt] of cp.tokenRequests) {
          this.#tokenRequests.set(id, sentAt);
        }
        for (const g of cp.grants) {
          const { freshnessOrigin, ...rest } = g;
          this.#grants.set(g.grantId, {
            ...rest,
            positiveAt: g.positiveAt ?? freshnessOrigin ?? null,
            lastAttemptStartAt: g.lastAttemptStartAt ?? null,
            // Version 1 kept one schedule for every grant.
            nextAttemptAt: g.nextAttemptAt === undefined ? (g.deletedAt === null ? cp.nextAttemptAt ?? null : null) : g.nextAttemptAt,
            readState: g.readState ?? "active",
            recordsTracked: g.recordsTracked ?? false,
            legacyAcquiredAt: g.legacyAcquiredAt === undefined ? (g.recordsTracked ? null : g.firstAcquiredAt) : g.legacyAcquiredAt,
            // Older checkpoints: a disposed legacy copy keeps its clock as the floor.
            legacyFloorAt: g.legacyFloorAt ?? (g.deletedAt !== null && g.legacyAcquiredAt != null ? g.legacyAcquiredAt : null),
            records: new Map(g.records ?? []),
            erasures: new Map(g.erasures.map(([id, e]) => [id, {
              ...e,
              effectiveAt: e.effectiveAt ?? e.receivedAt,
              stopUseBy: e.stopUseBy ?? (e.effectiveAt ?? e.receivedAt) + STOP_USE_BOUND_MS,
              stoppedUseAt: e.stoppedUseAt ?? e.receivedAt,
              learnedLate: e.learnedLate ?? false,
              overdue: e.overdue ?? false,
              retained: e.retained ?? null,
            }])),
            needsReconcile: false,
          });
        }
        for (const [identity, versions] of cp.acquisitions ?? []) {
          this.#acquisitions.set(identity, new Map(versions.map(([v, at]) => [v ?? undefined, at])));
        }
      }
    } catch {
      this.#stateUnavailable = true;
    }
    // Resuming from power-off after an attempt fell due needs an attempt before further use.
    this.#markDueAttempts(this.#now());
  }

  /**
   * Record that data was acquired under a grant. Only the first call sets the
   * first-acquisition time; rereads and resyncs never move it. Record delivery
   * is not an assessment, so this never makes data usable.
   */
  acquire(grantId: string, o: { processingPermission?: boolean } = {}): boolean {
    const prior = this.#grants.get(grantId);
    // A legacy copy has no record identities, so reacquiring it after any disposal cannot be told
    // from the old copy. Core counts the ceiling from first acquisition and never restarts it, so
    // it stays with the original acquisition. (A read after a retention disposal is still allowed.)
    const ceilingClock = prior?.deletedAt != null ? prior.legacyAcquiredAt : null;
    if (!this.#register(grantId, o)) return false;
    const g = this.#grants.get(grantId);
    if (!g) return false;
    g.legacyAcquiredAt = Math.min(g.legacyAcquiredAt ?? Number.POSITIVE_INFINITY, ceilingClock ?? Number.POSITIVE_INFINITY, g.firstAcquiredAt);
    if (this.policy.retentionCeilingMs !== null && this.#now() >= g.legacyAcquiredAt + this.policy.retentionCeilingMs) {
      // Nothing may be kept: dispose now and report that the caller must not store the copy.
      this.#disposeDue();
      return false;
    }
    // The write takes time: the copy may be kept only if no deadline is due on the sample after it.
    const written = this.#commit();
    if (written === null) {
      return false;
    }
    const due = this.deleteBy(grantId);
    if (due !== null && written >= due) {
      this.#disposeDue(written);
      return false;
    }
    return true;
  }

  /** Create or revive the grant entry in memory; the caller persists. */
  #register(grantId: string, o: { processingPermission?: boolean } = {}): boolean {
    const now = this.#now();
    if (this.#stateUnavailable || this.#clockUncertain) {
      this.#disposeDue();
      return false;
    }
    const prior = this.#grants.get(grantId);
    // Erasure is terminal: a late delivery under an erased grant is not an
    // acquisition. The caller must not keep it.
    if (prior && [...prior.erasures.values()].some((e) => e.scope.streams === "all")) {
      this.#log(grantId, "disposed", "late_delivery_under_erasure");
      return false;
    }
    // A read after a retention disposal is a new acquisition with
    // its own clocks; the ordering state is kept.
    if (!prior || prior.deletedAt !== null) {
      this.#grants.set(grantId, {
        grantId,
        readState: prior?.readState ?? "active",
        firstAcquiredAt: now,
        positiveAt: this.#tokenOrigins.get(grantId)?.origin ?? null,
        custodyOnly: false,
        processingPermission: (o.processingPermission ?? false) || (this.#tokenOrigins.get(grantId)?.processingPermission ?? false),
        lastPosition: prior?.lastPosition ?? 0,
        erasures: prior?.erasures ?? new Map(),
        deletedAt: null,
        deleteReason: null,
        needsReconcile: false,
        lastAttemptStartAt: null,
        // The first attempt is due one reconciliation interval after first acquisition.
        nextAttemptAt: now + this.policy.cadenceMs,
        pendingDeletionReason: null,
        recordsTracked: false,
        legacyAcquiredAt: null,
        legacyFloorAt: prior ? earliest(prior.legacyFloorAt, prior.legacyAcquiredAt) : null,
        records: new Map(),
      });
      this.#tokenOrigins.delete(grantId);
      this.#log(grantId, "acquire");
    }
    return true;
  }

  /** Record delivery per record; the returned set excludes copies whose retention already ended. */
  acquireRecords<T extends HeldRecordRef>(grantId: string, records: readonly T[]): T[] {
    if (this.policy.retentionCeilingMs !== null && !this.#store.disposeRecords) {
      throw new Error("per-record retention requires a store with disposeRecords");
    }
    if (this.policy.retentionCeilingMs !== null && !this.#store.recordRefs) {
      // Without an inventory a restored, expired record cannot be found, so it would stay usable.
      throw new Error("per-record retention requires a store with recordRefs");
    }
    const priorGrant = this.#grants.get(grantId);
    if (priorGrant && [...priorGrant.erasures.values()].some((e) => e.scope.streams === "all")) {
      return [];
    }
    const now = this.#now();
    if (this.#stateUnavailable || this.#clockUncertain) {
      // Clocks cannot be recorded durably or trusted: nothing is kept.
      this.#disposeDue();
      return [];
    }
    // Migrate the complete old inventory before accepting a new delivery. Without an
    // inventory, the original whole-copy deadline remains the conservative bound.
    if (priorGrant?.legacyAcquiredAt !== null && priorGrant?.legacyAcquiredAt !== undefined && this.#store.recordRefs) {
      let listed = 0;
      for (const ref of this.#store.recordRefs(grantId)) {
        listed += 1;
        const identity = JSON.stringify([ref.sourceId ?? null, ref.instanceId ?? null, ref.stream, ref.id]);
        const versions = this.#acquisitions.get(identity) ?? new Map<string | undefined, number>();
        const known = ref.version === undefined
          ? Math.min(...versions.values())
          : Math.min(versions.get(ref.version) ?? Number.POSITIVE_INFINITY, versions.get(undefined) ?? Number.POSITIVE_INFINITY);
        const firstAcquiredAt = Math.min(priorGrant.legacyAcquiredAt, known);
        versions.set(ref.version, firstAcquiredAt);
        this.#acquisitions.set(identity, versions);
        priorGrant.records.set(JSON.stringify([identity, ref.version ?? null]), { ref: {
          id: ref.id, stream: ref.stream,
          ...(ref.sourceId === undefined ? {} : { sourceId: ref.sourceId }),
          ...(ref.instanceId === undefined ? {} : { instanceId: ref.instanceId }),
          ...(ref.version === undefined ? {} : { version: ref.version }),
        }, firstAcquiredAt });
      }
      if (listed === 0) {
        // Nothing to migrate: the legacy copy was disposed or lost, so its clock cannot be dropped.
        // Whatever is delivered next may be that data again.
        priorGrant.legacyFloorAt = earliest(priorGrant.legacyFloorAt, priorGrant.legacyAcquiredAt);
      }
      priorGrant.recordsTracked = true;
      priorGrant.legacyAcquiredAt = null;
    }
    const legacyFloor = priorGrant?.legacyFloorAt ?? Number.POSITIVE_INFINITY;
    const eligible: { ref: T; key: string; firstAcquiredAt: number }[] = [];
    for (const ref of records) {
      const identity = JSON.stringify([ref.sourceId ?? null, ref.instanceId ?? null, ref.stream, ref.id]);
      const versions = this.#acquisitions.get(identity) ?? new Map<string | undefined, number>();
      const prior = ref.version === undefined
        ? Math.min(now, legacyFloor, ...versions.values())
        : Math.min(now, legacyFloor, versions.get(ref.version) ?? now, versions.get(undefined) ?? now);
      versions.set(ref.version, prior);
      this.#acquisitions.set(identity, versions);
      if (this.policy.retentionCeilingMs !== null && now >= prior + this.policy.retentionCeilingMs) {
        continue;
      }
      eligible.push({ ref, key: JSON.stringify([identity, ref.version ?? null]), firstAcquiredAt: prior });
    }
    // Clocks, grant entry and per-record state go in one write, before the caller may keep anything.
    if (eligible.length === 0) {
      this.#persist();
      return [];
    }
    if (!this.#register(grantId)) {
      return [];
    }
    const g = this.#grants.get(grantId);
    if (!g) {
      return [];
    }
    g.recordsTracked = true;
    for (const r of eligible) {
      g.records.set(r.key, { ref: {
        id: r.ref.id, stream: r.ref.stream,
        ...(r.ref.sourceId === undefined ? {} : { sourceId: r.ref.sourceId }),
        ...(r.ref.instanceId === undefined ? {} : { instanceId: r.ref.instanceId }),
        ...(r.ref.version === undefined ? {} : { version: r.ref.version }),
      }, firstAcquiredAt: r.firstAcquiredAt });
    }
    // The write takes time: a record is kept only if its ceiling is still ahead on the sample after
    // it. Disposing what the write crossed takes another write, so decide again until none is due.
    let live = eligible;
    for (;;) {
      const written = this.#commit();
      if (written === null) {
        return [];
      }
      const due = this.deleteBy(grantId);
      if (due === null || written < due) {
        return live.map((r) => r.ref);
      }
      this.#disposeDue(written);
      const after = this.#grants.get(grantId);
      live = after && after.deletedAt === null ? live.filter((r) => after.records.has(r.key)) : [];
      // A deadline that disposal did not clear cannot be shown ahead: keep nothing.
      const still = this.deleteBy(grantId);
      if (live.length === 0 || (still !== null && still <= written)) {
        return [];
      }
    }
  }

  /** The gate the app checks before every use. */
  canUse(grantId: string): UseDecision {
    this.#disposeDue();
    // Disposal can take time. Sample again, complete any newly due disposal,
    // then evaluate every guard without another clock read after those guards.
    this.#disposeDue(this.#now());
    this.#persist();
    if (this.#stateUnavailable || this.#clockUncertain) {
      return { ok: false, reason: "state_unavailable" };
    }
    const g = this.#grants.get(grantId);
    if (!g || g.deletedAt !== null) {
      return { ok: false, reason: "deleted" };
    }
    if ([...g.erasures.values()].some((e) => e.scope.streams === "all")) {
      return { ok: false, reason: "erased" };
    }
    if (g.needsReconcile) {
      return { ok: false, reason: "reconcile_required" };
    }
    if (g.custodyOnly || g.processingPermission) {
      return { ok: false, reason: "custody_only" };
    }
    // First use needs a positive assessment. After it, silence from the AS starts no deadline.
    if (g.positiveAt === null) {
      return { ok: false, reason: "no_assessment" };
    }
    // Durable writes take time: decide on the sample taken after the write.
    const written = this.#commit();
    if (written === null) {
      return { ok: false, reason: "state_unavailable" };
    }
    const due = this.deleteBy(grantId);
    if (due !== null && written >= due) {
      this.#disposeDue(written);
      return { ok: false, reason: this.#grants.get(grantId)?.deletedAt != null ? "deleted" : "disposal_due" };
    }
    // The same sample can detect a suspend: an attempt may have fallen due and must start first.
    if (g.needsReconcile) {
      return { ok: false, reason: "reconcile_required" };
    }
    return { ok: true, until: due };
  }

  /** Streams of a grant that a partial erasure has removed (narrowing). */
  erasedStreams(grantId: string): Set<string> {
    const out = new Set<string>();
    for (const e of this.#grants.get(grantId)?.erasures.values() ?? []) {
      if (e.scope.streams !== "all") {
        for (const s of e.scope.streams) {
          out.add(s);
        }
      }
    }
    return out;
  }

  /** The earliest deletion deadline now in force for a grant, or null. */
  deleteBy(grantId: string): number | null {
    const g = this.#grants.get(grantId);
    if (!g || g.deletedAt !== null) {
      return null;
    }
    const candidates: number[] = [];
    if (this.policy.retentionCeilingMs !== null) {
      if (g.legacyAcquiredAt !== null) candidates.push(g.legacyAcquiredAt + this.policy.retentionCeilingMs);
      if (g.recordsTracked) {
        for (const r of g.records.values()) {
          candidates.push(r.firstAcquiredAt + this.policy.retentionCeilingMs);
        }
      } else {
        candidates.push(g.firstAcquiredAt + this.policy.retentionCeilingMs);
      }
    }
    for (const e of g.erasures.values()) {
      if (e.scope.streams === "all" && e.disposedAt === null) {
        candidates.push(e.deleteBy);
      }
    }
    return candidates.length ? Math.min(...candidates) : null;
  }

  grantState(grantId: string): Readonly<HeldGrant> | undefined {
    return structuredClone(this.#grants.get(grantId));
  }

  /** Write ahead before token I/O. Reusing a request id preserves its original send time. */
  beginTokenRequest(requestId: string): number | null {
    const now = this.#now();
    if (this.#stateUnavailable || this.#clockUncertain) {
      return null;
    }
    const origin = this.#tokenRequests.get(requestId) ?? now;
    this.#tokenRequests.set(requestId, origin);
    return this.#persist() ? origin : null;
  }

  /** Authenticated token authorization result only; recovery tokens are not assessments. */
  onTokenResponse(o: {
    grantIds: readonly string[];
    /** Prefer a durable request id; explicit send time is for callers persisting their own requests. */
    requestId?: string;
    sentAt?: number;
    processingPermissionGrantIds?: readonly string[];
    lifecycleRecovery?: boolean;
  }): void {
    this.#disposeDue();
    if (o.lifecycleRecovery || this.#stateUnavailable || this.#clockUncertain) {
      return;
    }
    const sentAt = o.requestId === undefined ? o.sentAt : this.#tokenRequests.get(o.requestId);
    if (sentAt === undefined || !Number.isFinite(sentAt) || sentAt > this.#now()) {
      throw new Error("invalid token assessment origin");
    }
    for (const id of o.grantIds) {
      const g = this.#grants.get(id);
      if (g && [...g.erasures.values()].some((e) => e.scope.streams === "all")) {
        continue;
      }
      if (g && g.deletedAt === null) {
        g.processingPermission ||= o.processingPermissionGrantIds?.includes(id) ?? false;
        g.positiveAt = Math.max(g.positiveAt ?? -Infinity, sentAt);
        // A token response that returns the grant counts as a query: it ends retries and restarts
        // the reconciliation interval, unless a later attempt has already started.
        if (sentAt >= (g.lastAttemptStartAt ?? -Infinity)) {
          g.lastAttemptStartAt = sentAt;
          g.nextAttemptAt = sentAt + this.policy.cadenceMs;
        }
        g.needsReconcile = false;
      } else {
        const prior = this.#tokenOrigins.get(id);
        this.#tokenOrigins.set(id, {
          origin: Math.max(prior?.origin ?? -Infinity, sentAt),
          processingPermission: (o.processingPermissionGrantIds?.includes(id) ?? false) || (prior?.processingPermission ?? false),
        });
      }
      this.#log(id, "positive", String(sentAt));
    }
    if (this.#persist()) {
      this.#relayAll();
    }
  }

  /** Run due work: overdue disposal first, then a lifecycle query attempt for each grant that owes one. */
  async tick(): Promise<void> {
    this.#disposeDue();
    const now = this.#now();
    const due = [...this.#grants.values()]
      .filter((g) => this.#holds(g) && g.nextAttemptAt !== null && now >= g.nextAttemptAt)
      .map((g) => g.grantId);
    if (due.length > 0) {
      await this.#attempt(due);
    }
    this.#persist();
  }

  /** A read failed with the grant shown inactive: start a query before further use of this grant. */
  async onReadFailure(grantId: string): Promise<void> {
    const g = this.#grants.get(grantId);
    if (g) {
      g.needsReconcile = true;
    }
    this.#persist();
    await this.#attempt([grantId]);
  }

  /**
   * After a suspend or restart: dispose of anything overdue. If an attempt fell due meanwhile, start
   * a query before any use. Whether it succeeds does not matter to use the grant's terms permit.
   */
  async onResume(): Promise<void> {
    this.#markDueAttempts(this.#now());
    this.#persist();
    this.#disposeDue();
    const owed = [...this.#grants.values()].filter((g) => this.#holds(g) && g.needsReconcile).map((g) => g.grantId);
    await this.#attempt(owed);
  }

  /**
   * The owner asked the client directly to delete. That is an instruction effective at once and the
   * client's first receipt: the clocks start now, whether or not the AS hears. Returns its id.
   */
  ownerDelete(grantId: string): string {
    const operationId = `local_${grantId}_${this.#now()}`;
    this.#receiveErasure(grantId, operationId, { streams: "all" });
    this.#relayAll();
    this.#disposeDue();
    return operationId;
  }

  /**
   * Declare legal retention for data an instruction covers, before that data is deleted. Returns
   * false (and keeps nothing) when it cannot be honoured: the store cannot delete all but the named
   * records, a named record is not held, or the end is a date that has passed.
   */
  declareLegalRetention(grantId: string, operationId: string, spec: LegalRetentionSpec): boolean {
    const g = this.#grants.get(grantId);
    const e = g?.erasures.get(operationId);
    if (!g || !e || e.disposedAt !== null || this.#stateUnavailable || this.#clockUncertain) {
      return false;
    }
    return this.#acceptRetention(g, e, spec) && this.#persist();
  }

  /**
   * Correct the terms of retention already reported (a later `retained` report corrects an earlier
   * one). The kept records stay as declared. Reports the new terms.
   */
  correctLegalRetention(
    grantId: string,
    operationId: string,
    terms: Partial<Pick<LegalRetentionSpec, "scope" | "basis" | "end" | "requiredProcessing" | "lawProhibits">>
  ): boolean {
    const e = this.#grants.get(grantId)?.erasures.get(operationId);
    const r = e?.retained;
    if (!e || !r || r.endedAt !== null || this.#stateUnavailable || this.#clockUncertain) {
      return false;
    }
    const next = this.#retentionTerms({ ...r, ...terms }, this.#now());
    if (!next) {
      return false;
    }
    Object.assign(r, next, { reported: false });
    if (!this.#persist()) {
      return false;
    }
    void this.#reportOp(grantId, operationId, "retained");
    return true;
  }

  /**
   * The obligation ended (the event happened, or the owner of the obligation says so): delete the
   * retained data and report `completed`. A date end is handled by `tick`.
   */
  endLegalRetention(grantId: string, operationId: string): boolean {
    const g = this.#grants.get(grantId);
    const e = g?.erasures.get(operationId);
    if (!g || !e || this.#stateUnavailable || this.#clockUncertain) {
      return false;
    }
    return this.#endRetention(g, operationId, e, this.#now());
  }

  /** Send the `retained` report again, e.g. after the client gains current authentication. */
  async reportRetention(grantId: string, operationId: string): Promise<boolean> {
    await this.#reportOp(grantId, operationId, "retained");
    return this.#grants.get(grantId)?.erasures.get(operationId)?.retained?.reported ?? false;
  }

  /**
   * Gate for processing legally retained data: only the processing the obligation requires, and only
   * while the obligation lasts. Ordinary use of the data stays refused by `canUse`.
   */
  canProcessRetained(
    grantId: string,
    processing: string
  ): { ok: true } | { ok: false; reason: "state_unavailable" | "no_retention" | "ended" | "not_required" } {
    this.#disposeDue();
    this.#persist();
    if (this.#stateUnavailable || this.#clockUncertain) {
      return { ok: false, reason: "state_unavailable" };
    }
    let reason: "no_retention" | "ended" | "not_required" = "no_retention";
    for (const e of this.#grants.get(grantId)?.erasures.values() ?? []) {
      if (!e.retained) {
        continue;
      }
      if (e.retained.endedAt !== null) {
        reason = "ended";
      } else if (e.retained.requiredProcessing.includes(processing)) {
        return { ok: true };
      } else if (reason !== "ended") {
        reason = "not_required";
      }
    }
    return { ok: false, reason };
  }

  /** The legal retention recorded for an instruction, if any. */
  legalRetentionOf(grantId: string, operationId: string): Readonly<LegalRetention> | null {
    return structuredClone(this.#grants.get(grantId)?.erasures.get(operationId)?.retained ?? null);
  }

  /** Attempt a lifecycle query for every held grant now. */
  async reconcile(): Promise<void> {
    await this.#attempt([...this.#grants.values()].filter((g) => this.#holds(g)).map((g) => g.grantId));
  }

  /** The earliest time any held grant owes its next attempt, or null if none does. */
  get nextAttemptAt(): number | null {
    return earliest(...[...this.#grants.values()].filter((g) => this.#holds(g)).map((g) => g.nextAttemptAt));
  }

  /** Data that a legal obligation keeps is still held data of the grant. */
  #holds(g: HeldGrant): boolean {
    return g.deletedAt === null || [...g.erasures.values()].some((e) => e.retained !== null && e.retained.endedAt === null);
  }

  /** An attempt that fell due while the client was off or suspended must start before further use. */
  #markDueAttempts(now: number): void {
    for (const g of this.#grants.values()) {
      if (this.#holds(g) && g.nextAttemptAt !== null && now >= g.nextAttemptAt) {
        g.needsReconcile = true;
      }
    }
  }

  /**
   * Start a lifecycle query for each grant. The attempt, not its success, clears the duty to query
   * before use; an unanswered or failed attempt never stops use the grant's terms permit. The next
   * attempt is owed within the retry interval of THIS attempt's start until one succeeds, so a request
   * that never returns does not hold up the retry. The reconciliation interval caps any Retry-After.
   */
  async #attempt(ids: readonly string[]): Promise<void> {
    // Overdue disposal comes before any new assessment, on every entry path.
    this.#disposeDue();
    if (this.#stateUnavailable || this.#clockUncertain) {
      return;
    }
    const held = ids.filter((id) => {
      const g = this.#grants.get(id);
      return g !== undefined && this.#holds(g);
    });
    const sentAt = this.#now();
    for (const id of this.#grants.keys()) {
      const g = this.#grants.get(id);
      if (g && !this.#holds(g)) {
        // No held data, so no further query is owed.
        g.nextAttemptAt = null;
      }
    }
    if (held.length === 0) {
      this.#persist();
      return;
    }
    for (const id of held) {
      const g = this.#grants.get(id);
      if (g) {
        g.lastAttemptStartAt = sentAt;
        g.nextAttemptAt = sentAt + Math.min(this.policy.retryMs, this.policy.cadenceMs);
        g.needsReconcile = false;
      }
    }
    // The start is durable before the request leaves.
    if (!this.#persist()) {
      return;
    }
    const groups = this.#batch ? [held] : held.map((id) => [id]);
    for (const group of groups) {
      let r: Awaited<ReturnType<StatusTransport>>;
      try {
        r = await this.#status(group);
      } catch (err) {
        r = { ok: false, reason: err instanceof Error ? err.message : "unreachable" };
      }
      // A deadline may have passed while the response was in flight. Dispose
      // before the answer is applied.
      this.#disposeDue();
      if (this.#stateUnavailable || this.#clockUncertain) {
        return;
      }
      if (!r.ok) {
        this.#scheduleAfter(group, sentAt, true, r.retryAfterMs ?? 0);
        for (const id of group) {
          this.#log(id, "status_failed", r.reason);
        }
        continue;
      }
      // A grant counts as answered only with exactly one lifecycle answer for
      // it. A per-grant error, a missing entry or a duplicate is a failed
      // attempt for that grant, retried within the retry interval.
      for (const id of group) {
        const entries = r.results.filter((x) => x.grant_id === id);
        const only = entries.length === 1 ? entries[0] : undefined;
        if (!only || "error" in only) {
          this.#scheduleAfter([id], sentAt, true, 0);
          this.#log(id, "status_failed", only && "error" in only ? only.error : "no_answer");
          continue;
        }
        // The write for an earlier grant in this loop can pass this grant's deadline. Dispose first,
        // so the answer cannot arrive after a deadline that already passed.
        this.#disposeDue();
        if (this.#stateUnavailable || this.#clockUncertain) {
          return;
        }
        if (this.#grants.get(id)?.deletedAt != null) {
          this.#scheduleAfter([id], sentAt, false, 0);
          continue;
        }
        this.#apply(only, sentAt);
        this.#scheduleAfter([id], sentAt, false, 0);
        if (!this.#persist()) {
          return;
        }
      }
    }
    if (!this.#persist()) {
      return;
    }
    this.#disposeDue();
    this.#relayAll();
  }

  /** Set the next attempt after an attempt that started at `sentAt`, unless a later attempt has started. */
  #scheduleAfter(ids: readonly string[], sentAt: number, failed: boolean, retryAfterMs: number): void {
    for (const id of ids) {
      const g = this.#grants.get(id);
      if (!g || !this.#holds(g) || (g.lastAttemptStartAt ?? Number.NEGATIVE_INFINITY) > sentAt) {
        continue;
      }
      // Retry-After MAY replace the retry interval, but the reconciliation interval still binds.
      const wait = failed ? Math.max(this.policy.retryMs, retryAfterMs) : this.policy.cadenceMs;
      g.nextAttemptAt = sentAt + Math.min(wait, this.policy.cadenceMs);
    }
  }

  #apply(res: StatusResult, sentAt: number): void {
    const g = this.#grants.get(res.grant_id);
    if (!g) {
      return;
    }
    if ("error" in res) {
      // Unknown, foreign and lost grants look the same by design. No positive assessment.
      this.#log(g.grantId, "status_failed", res.error);
      return;
    }
    if (res.as_position < g.lastPosition) {
      this.#log(g.grantId, "ignored_stale_answer", `${res.as_position} < ${g.lastPosition}`);
      return;
    }
    g.lastPosition = res.as_position;
    g.readState = res.grant_state;
    for (const e of res.erasures) {
      this.#receiveErasure(g.grantId, e.operation_id, e.scope, e.effective_at);
    }
    g.custodyOnly = res.ordinary_use === "custody_only";
    // Custody-only is still a positive assessment of custody; it permits no use.
    if (res.ordinary_use !== "stopped") {
      // The client's own send time, so an AS clock that runs ahead cannot make the record later.
      g.positiveAt = Math.max(g.positiveAt ?? Number.NEGATIVE_INFINITY, sentAt);
      this.#log(g.grantId, "positive", String(sentAt));
    }
  }

  /**
   * First authenticated receipt of an instruction. Use stops now, which is within the stop-use bound
   * of the effective time or, for a client that learns later, at once. The deletion clock starts at
   * this first receipt and no redelivery restarts it.
   */
  #receiveErasure(grantId: string, operationId: string, scope: ErasureScope, effectiveAt?: number): void {
    const g = this.#grants.get(grantId);
    if (!g || g.erasures.has(operationId)) {
      // Redelivery never restarts a clock.
      return;
    }
    const now = this.#now();
    // The instruction applies from its effective time, so the client cannot have learned it earlier.
    // An AS clock that runs ahead cannot push the bound later than receipt allows.
    const effective = effectiveAt !== undefined && Number.isFinite(effectiveAt) ? Math.min(effectiveAt, now) : now;
    g.erasures.set(operationId, {
      scope,
      receivedAt: now,
      deleteBy: now + this.policy.deletionPeriodMs,
      effectiveAt: effective,
      stopUseBy: effective + STOP_USE_BOUND_MS,
      stoppedUseAt: now,
      learnedLate: now > effective + STOP_USE_BOUND_MS,
      disposedAt: null,
      overdue: false,
      receiptReported: false,
      completionReported: false,
      disposalPending: false,
      retained: null,
    });
    this.#log(grantId, "erasure_received", operationId);
    if (this.#persist()) {
      void this.#reportOp(grantId, operationId, "receipt");
    }
  }

  #disposeDue(now = this.#now()): void {
    if (this.#stateUnavailable || this.#clockUncertain) {
      // Unknown deadlines are due under Core. No new acquisition can reset them.
      this.#persist();
      this.#disposeInventory();
      return;
    }
    for (const g of this.#grants.values()) {
      if (g.deletedAt !== null) {
        // A restored data backup must replay deletion state before any use.
        this.#disposeCopies(g.grantId, { streams: "all" });
        this.#endDueRetentions(g, now);
        continue;
      }
      for (const [opId, e] of g.erasures) {
        if (e.disposedAt !== null) {
          // The library also models partial scopes: replay them against restored
          // data even though the original disposal is already recorded complete.
          this.#disposeCopies(g.grantId, e.scope);
          continue;
        }
        const due = e.disposalPending || this.policy.disposeAt === "promptly" || now >= e.deleteBy;
        if (e.disposedAt === null && due) {
          this.#resolveLegalRetention(g, opId, e, now);
          e.disposalPending = true;
          if (!this.#persist()) {
            this.#disposeCopies(g.grantId, e.scope);
            return;
          }
          this.#disposeCopies(g.grantId, e.scope);
          e.disposedAt = now;
          // A deadline missed (for example while powered off) stays on record and is never reported as met.
          e.overdue = now > e.deleteBy;
          e.disposalPending = false;
          this.#log(g.grantId, "disposed", opId);
          if (e.scope.streams === "all") {
            g.deletedAt = now;
            g.deleteReason = "erasure";
            g.records.clear();
          }
          if (this.#persist()) {
            void this.#reportOp(g.grantId, opId, e.retained ? "retained" : "completion");
          }
        }
      }
      if (g.deletedAt !== null) {
        continue;
      }
      const grantDeadlines: number[] = [];
      if (g.legacyAcquiredAt !== null && this.policy.retentionCeilingMs !== null) {
        grantDeadlines.push(g.legacyAcquiredAt + this.policy.retentionCeilingMs);
      }
      // Per-record ceilings never use the grant's first acquisition: a later record keeps its own clock.
      const by = grantDeadlines.length ? Math.min(...grantDeadlines) : null;
      // Per-record clocks need an inventory to sweep restored copies. If the store cannot give one,
      // the deadlines cannot be shown to remain in the future (Core): the whole grant is due.
      const inventoryUnavailable = g.recordsTracked && this.policy.retentionCeilingMs !== null && !this.#store.recordRefs;
      if (g.pendingDeletionReason !== null || inventoryUnavailable || (by !== null && now >= by)) {
        g.pendingDeletionReason ??= "retention_ceiling";
        if (!this.#persist()) {
          this.#disposeCopies(g.grantId, { streams: "all" });
          return;
        }
        this.#disposeCopies(g.grantId, { streams: "all" });
        g.deletedAt = now;
        g.deleteReason = g.pendingDeletionReason;
        g.pendingDeletionReason = null;
        g.records.clear();
        g.legacyFloorAt = earliest(g.legacyFloorAt, g.legacyAcquiredAt);
        this.#persist();
        this.#log(g.grantId, "disposed", g.deleteReason);
      }
      if (g.deletedAt === null && g.recordsTracked && this.policy.retentionCeilingMs !== null) {
        const retentionCeilingMs = this.policy.retentionCeilingMs;
        const due = [...g.records].filter(([, r]) => now >= r.firstAcquiredAt + retentionCeilingMs);
        // A data backup restored after a disposal brings back records the grant no longer tracks.
        // Acquisition history outlives the grant entry: sweep any inventory it shows past its ceiling.
        const known = new Set(due.map(([key]) => key));
        for (const ref of this.#store.recordRefs?.(g.grantId) ?? []) {
          const identity = JSON.stringify([ref.sourceId ?? null, ref.instanceId ?? null, ref.stream, ref.id]);
          const key = JSON.stringify([identity, ref.version ?? null]);
          const versions = this.#acquisitions.get(identity);
          if (!versions || g.records.has(key) || known.has(key)) {
            continue;
          }
          const first = ref.version === undefined
            ? Math.min(...versions.values())
            : Math.min(versions.get(ref.version) ?? Number.POSITIVE_INFINITY, versions.get(undefined) ?? Number.POSITIVE_INFINITY);
          if (now >= first + retentionCeilingMs) {
            known.add(key);
            due.push([key, { ref, firstAcquiredAt: first }]);
          }
        }
        if (due.length > 0) {
          if (!this.#store.disposeRecords) {
            throw new Error("per-record retention requires a store with disposeRecords");
          }
          // The due clocks are already durable, so a crash during disposal retries the same records.
          // A failed write disposes the whole inventory (fail closed).
          if (!this.#persist()) {
            return;
          }
          this.#store.disposeRecords(g.grantId, due.map(([, r]) => r.ref));
          for (const [key] of due) {
            g.records.delete(key);
          }
          this.#log(g.grantId, "disposed", "retention_ceiling");
          if (g.records.size === 0 && g.legacyAcquiredAt === null) {
            g.deletedAt = now;
            g.deleteReason = "retention_ceiling";
          }
          this.#persist();
        }
      }
    }
  }

  /** Remove the copies in scope, except records held under legal retention that has not ended. */
  #disposeCopies(grantId: string, scope: ErasureScope): void {
    const g = this.#grants.get(grantId);
    // Without durable state the retention cannot be shown, so nothing is exempt.
    const kept = g && !this.#stateUnavailable ? this.#retainedRefs(g) : [];
    if (kept.length === 0 || !(this.#store.recordRefs && this.#store.disposeRecords)) {
      this.#store.dispose(grantId, scope);
      return;
    }
    const inScope = (r: HeldRecordRef) => scope.streams === "all" || scope.streams.includes(r.stream);
    const doomed = [...this.#store.recordRefs(grantId)].filter((r) => inScope(r) && !kept.some((k) => sameRef(k, r)));
    if (doomed.length > 0) {
      this.#store.disposeRecords(grantId, doomed);
    }
  }

  #retainedRefs(g: HeldGrant): HeldRecordRef[] {
    return [...g.erasures.values()].flatMap((e) => (e.retained && e.retained.endedAt === null ? e.retained.records : []));
  }

  /** Before deleting, ask the client's law whether it requires some of the covered data to be kept. */
  #resolveLegalRetention(g: HeldGrant, operationId: string, e: HeldErasure, now: number): void {
    if (e.retained === null && this.#legalRetention) {
      const spec = this.#legalRetention({ grantId: g.grantId, operationId, scope: e.scope });
      if (spec) {
        this.#acceptRetention(g, e, spec);
      }
    }
    // An obligation that ended before the deletion ran keeps nothing.
    if (e.retained?.end.kind === "date" && now >= e.retained.end.at) {
      e.retained = null;
    }
  }

  /** Validate and record legal retention. Nothing is invented: the end is a date, an event or unknown. */
  #acceptRetention(g: HeldGrant, e: HeldErasure, spec: LegalRetentionSpec): boolean {
    const terms = this.#retentionTerms(spec, this.#now());
    if (!terms || !this.#store.recordRefs || !this.#store.disposeRecords || spec.records.length === 0) {
      return false;
    }
    // Every named record must be held now, so the exemption names real data.
    const held = [...this.#store.recordRefs(g.grantId)];
    if (!spec.records.every((k) => held.some((r) => sameRef(k, r)))) {
      return false;
    }
    e.retained = {
      ...terms,
      records: spec.records.map((r) => ({ ...r })),
      recordedAt: this.#now(),
      endedAt: null,
      reported: false,
    };
    return true;
  }

  #retentionTerms(
    t: Pick<LegalRetentionSpec, "scope" | "basis" | "end" | "requiredProcessing" | "lawProhibits">,
    now: number
  ): Pick<LegalRetention, "scope" | "basis" | "end" | "requiredProcessing" | "lawProhibits"> | null {
    const endOk =
      (t.end.kind === "date" && Number.isFinite(t.end.at) && t.end.at > now) ||
      (t.end.kind === "event" && t.end.text.trim() !== "") ||
      t.end.kind === "unknown";
    if (!endOk || t.scope.trim() === "" || t.basis.trim() === "") {
      return null;
    }
    return {
      scope: t.scope,
      basis: t.basis,
      end: structuredClone(t.end),
      requiredProcessing: [...(t.requiredProcessing ?? [])],
      lawProhibits: { report: false, basis: false, scope: false, ...t.lawProhibits },
    };
  }

  #endDueRetentions(g: HeldGrant, now: number): void {
    for (const [opId, e] of g.erasures) {
      if (e.retained && e.retained.endedAt === null && e.retained.end.kind === "date" && now >= e.retained.end.at) {
        this.#endRetention(g, opId, e, now);
      }
    }
  }

  /** The obligation ended: delete what it kept, then report completion (never before). */
  #endRetention(g: HeldGrant, operationId: string, e: HeldErasure, now: number): boolean {
    const r = e.retained;
    if (!r || r.endedAt !== null) {
      return false;
    }
    r.endedAt = now;
    // Durable before the deletion, so a crash in between replays the deletion (see #disposeDue).
    if (!this.#persist()) {
      return true;
    }
    this.#disposeCopies(g.grantId, { streams: "all" });
    this.#log(g.grantId, "disposed", "legal_retention_ended");
    if (this.#persist()) {
      void this.#reportOp(g.grantId, operationId, "completion");
    }
    return true;
  }

  async #reportOp(grantId: string, operationId: string, kind: "receipt" | "completion" | "retained"): Promise<void> {
    const e = this.#grants.get(grantId)?.erasures.get(operationId);
    if (!(this.#report && e) || operationId.startsWith("local_") || !this.#persist()) {
      return;
    }
    const r = e.retained;
    // Deletion is not complete while legally retained data remains, and law may bar the report itself.
    if ((kind === "completion" && r && r.endedAt === null) || (kind === "retained" && (!r || r.lawProhibits.report))) {
      return;
    }
    try {
      const ok = await this.#report({
        grantId,
        operationId,
        kind,
        reportedAt:
          kind === "receipt" ? e.receivedAt : kind === "retained" ? (e.disposedAt ?? this.#now()) : (r?.endedAt ?? e.disposedAt ?? this.#now()),
        ...(kind === "completion" ? { outcome: "deleted" as const } : {}),
        ...(kind === "retained" && r
          ? {
              retainedUntil: r.end,
              ...(r.lawProhibits.basis ? {} : { retentionBasis: r.basis }),
              ...(r.lawProhibits.scope ? {} : { retentionScope: r.scope }),
            }
          : {}),
      });
      if (ok && kind === "receipt") {
        e.receiptReported = true;
      } else if (ok && kind === "retained" && r) {
        r.reported = true;
      } else if (ok) {
        e.completionReported = true;
      }
      this.#persist();
    } catch {
      // Retried on the next reconcile is not built; the AS then shows the operation as delivered but unconfirmed.
    }
  }

  #relayAll(): void {
    if (!this.#persist()) {
      return;
    }
    for (const g of this.#grants.values()) {
      const decision = this.canUse(g.grantId);
      const notice: DownstreamNotice = {
        grantId: g.grantId,
        issuedAt: this.#now(),
        usable: decision.ok,
        useUntil: decision.ok ? decision.until : null,
        erasures: [...g.erasures].map(([operationId, e]) => ({
          operationId, scope: e.scope, deleteBy: e.deleteBy, effectiveAt: e.effectiveAt, stopUseBy: e.stopUseBy,
        })),
        deleteAllBy: this.deleteBy(g.grantId),
      };
      for (const d of this.#downstream) {
        // A preceding callback or the issuedAt reading can expose a clock
        // discontinuity. Recheck immediately before licensing downstream use.
        const current = this.canUse(g.grantId);
        notice.usable = current.ok;
        notice.useUntil = current.ok ? current.until : null;
        if (this.#clockUncertain) {
          notice.deleteAllBy = this.#highWaterMs;
        }
        if (this.#persist()) {
          d.relay(notice);
        }
      }
    }
  }

  #log(grantId: string, kind: LifecycleEvent["kind"], detail?: string): void {
    this.events.push({ at: this.#now(), grantId, kind, ...(detail === undefined ? {} : { detail }) });
  }

  #readTime(wall: number, mono?: number): number {
    if (!Number.isFinite(wall) || wall < this.#highWaterMs) {
      this.#clockUncertain = true;
    }
    if (mono !== undefined && this.#timeAnchor) {
      const elapsed = mono - this.#timeAnchor.mono;
      if (!Number.isFinite(elapsed) || elapsed < 0) {
        this.#clockUncertain = true;
      }
      // Both clocks are injected, as in the lease guard. Wall time covers suspend;
      // monotonic progress prevents a slow wall clock extending elapsed limits.
      this.#highWaterMs = Math.max(this.#highWaterMs, this.#timeAnchor.wall + Math.max(0, elapsed));
      if (wall - this.#timeAnchor.wall - elapsed > 1000) {
        // A suspend: if an attempt fell due meanwhile, one must start before further use.
        this.#markDueAttempts(Math.max(this.#highWaterMs, wall));
      }
    }
    if (Number.isFinite(wall)) {
      this.#highWaterMs = Math.max(this.#highWaterMs, wall);
    }
    if (mono !== undefined) {
      this.#timeAnchor = { wall: this.#highWaterMs, mono };
    }
    return this.#highWaterMs;
  }

  /**
   * Durable write, then one more clock sample with no I/O after it, so a write that crossed a
   * deadline cannot license use or storage past it. Null: the state or the clock cannot show that
   * a deadline remains ahead, so disposal is due (Core) and has been done.
   */
  #commit(): number | null {
    if (!this.#persist()) {
      return null;
    }
    const at = this.#now();
    if (this.#clockUncertain) {
      this.#disposeDue(at);
      return null;
    }
    return at;
  }

  #persist(): boolean {
    if (this.#stateUnavailable) {
      return false;
    }
    try {
      this.#storage.write(JSON.stringify({
        version: 2, revision: ++this.#revision, policy: this.policy,
        highWaterMs: this.#highWaterMs, clockUncertain: this.#clockUncertain,
        tokenOrigins: [...this.#tokenOrigins],
        tokenRequests: [...this.#tokenRequests],
        acquisitions: [...this.#acquisitions].map(([identity, versions]) => [
          identity, [...versions].map(([v, at]) => [v ?? null, at]),
        ]),
        grants: [...this.#grants.values()].map((g) => ({ ...g, records: [...g.records], erasures: [...g.erasures] })),
      }));
      return true;
    } catch {
      this.#stateUnavailable = true;
      this.#disposeInventory();
      return false;
    }
  }

  #disposeInventory(): void {
    const errors: unknown[] = [];
    for (const id of new Set([...this.#store.grantIds(), ...this.#grants.keys()])) {
      try {
        this.#disposeCopies(id, { streams: "all" });
      } catch (error) {
        // One unavailable holder must not prevent disposal of the other copies.
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "client could not complete fail-closed disposal");
    }
  }
}
