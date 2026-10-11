// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side held-data lifecycle (integration-v2 K2, K3, K8, K9).
 *
 * The client keeps, per grant whose data it holds:
 * - the freshness origin of its last positive assessment (K3);
 * - the erasure instructions it has received, each with its own deletion
 *   deadline, measured from first authenticated receipt (B2);
 * - the first-acquisition time, which no reread or transform moves (K5).
 *
 * `canUse` is the gate the app checks before every use. `tick` attempts
 * status on schedule and disposes of anything overdue. All time comes from
 * the injected clock.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import { z } from "zod";
import type { ErasureScope, StatusAnswer, StatusResult } from "./authority.ts";
import { type ClientCheckpointStorage, MemoryClientCheckpointStorage } from "./checkpoint.ts";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface LifecyclePolicy {
  /** Attempt status at least this often while any covered data is held. */
  cadenceMs: number;
  /** Retry delay after a failed attempt. integration-v2 does not set one. */
  retryMs: number;
  /** OD-4: pause ordinary use when the last positive assessment is older than this. */
  pauseThresholdMs: number;
  /** Delete within this period of first authenticated receipt (B2). */
  deletionPeriodMs: number;
  /** OD-5: delete after this long with no positive assessment. Null: off. */
  longStopMs: number | null;
  /** Retention ceiling from first acquisition (K5). Null: no stated limit. */
  retentionCeilingMs: number | null;
  /**
   * Freshness origin of a positive answer. `request_sent` uses the earlier of
   * the AS assessment time and the local send time, so an AS clock that runs
   * ahead cannot extend use. `assessed_at` is integration-v2 read literally.
   *
   * NON-CONFORMING COMPARISON MODE: `assessed_at` lets an AS clock that runs ahead extend use
   * and the long-stop by the skew, which Core's no-extension rule forbids. It exists only so a
   * test can measure that difference. Never use it outside a comparison experiment.
   */
  freshnessOrigin: "request_sent" | "assessed_at";
  /** When the app disposes of data under an instruction: at once, or at the latest permitted time. */
  disposeAt: "promptly" | "deadline";
}

export const DEFAULT_POLICY: LifecyclePolicy = {
  cadenceMs: DAY_MS,
  retryMs: HOUR_MS,
  pauseThresholdMs: 7 * DAY_MS,
  deletionPeriodMs: 30 * DAY_MS,
  longStopMs: 90 * DAY_MS,
  retentionCeilingMs: null,
  freshnessOrigin: "request_sent",
  disposeAt: "promptly",
};

export type StatusTransport = (
  grantIds: readonly string[],
) => Promise<
  | { ok: true; results: StatusResult[] }
  /** `retryAfterMs`: a server-directed wait (HTTP 429 or 503 `Retry-After`). */
  | { ok: false; reason: string; retryAfterMs?: number }
>;

/** Client writes (receipt, completion). Need current client authentication. */
export type ReportTransport = (r: {
  grantId: string;
  operationId: string;
  kind: "receipt" | "completion";
  outcome?: "deleted" | "exception";
  /** Client time of the event: first receipt, or completion. */
  reportedAt?: number;
}) => Promise<boolean>;

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
  /** Complete inventory for migrating a legacy acquisition to per-record clocks. */
  recordRefs?(grantId: string): Iterable<HeldRecordRef>;
  /** Remove the covered records and every derivative built from them. */
  dispose(grantId: string, scope: ErasureScope): void;
  /** Remove these versions and delete or regenerate every derivative that used them. */
  disposeRecords?(grantId: string, records: readonly HeldRecordRef[]): void;
}

/** K8: what a downstream holder receives. Absolute times only. */
export interface DownstreamNotice {
  grantId: string;
  /** Client time the notice was issued, so a holder can order reordered deliveries. */
  issuedAt?: number;
  /** Stop ordinary use at this instant unless a later notice extends it. */
  useUntil: number | null;
  /** Erasures, each with its original absolute deadline. */
  erasures: { operationId: string; scope: ErasureScope; deleteBy: number }[];
  deleteAllBy: number | null;
}

export interface Downstream {
  relay(n: DownstreamNotice): void;
}

export type UseDecision =
  | { ok: true; until: number }
  | {
      ok: false;
      reason: "deleted" | "erased" | "no_assessment" | "stale" | "reconcile_required" | "custody_only" | "state_unavailable";
    };

interface HeldErasure {
  scope: ErasureScope;
  receivedAt: number;
  deleteBy: number;
  disposedAt: number | null;
  receiptReported: boolean;
  completionReported: boolean;
  disposalPending: boolean;
}

interface HeldGrant {
  grantId: string;
  readState: StatusAnswer["grant_state"];
  firstAcquiredAt: number;
  freshnessOrigin: number | null;
  custodyOnly: boolean;
  /** Known locally: the grant carries a processing permission, so it has no surviving use. */
  processingPermission: boolean;
  lastPosition: number;
  erasures: Map<string, HeldErasure>;
  deletedAt: number | null;
  deleteReason: string | null;
  needsReconcile: boolean;
  pendingDeletionReason: string | null;
  recordsTracked: boolean;
  legacyAcquiredAt: number | null;
  records: Map<string, HeldRecord>;
}

const time = z.number().finite();
const interval = time.nonnegative();
const policySchema = z.object({
  cadenceMs: interval, retryMs: interval, pauseThresholdMs: interval, deletionPeriodMs: interval,
  longStopMs: interval.nullable(), retentionCeilingMs: interval.nullable(),
  freshnessOrigin: z.enum(["request_sent", "assessed_at"]), disposeAt: z.enum(["promptly", "deadline"]),
});
const refSchema = z.object({
  id: z.string(), stream: z.string(), sourceId: z.string().optional(), instanceId: z.string().optional(),
  version: z.string().optional(),
}).transform((ref): HeldRecordRef => ({
  id: ref.id, stream: ref.stream,
  ...(ref.sourceId === undefined ? {} : { sourceId: ref.sourceId }),
  ...(ref.instanceId === undefined ? {} : { instanceId: ref.instanceId }),
  ...(ref.version === undefined ? {} : { version: ref.version }),
}));
const checkpointSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(), policy: policySchema,
  highWaterMs: time, clockUncertain: z.boolean(), nextAttemptAt: time.nullable(),
  tokenOrigins: z.array(z.tuple([z.string(), z.object({ origin: time, processingPermission: z.boolean() })])),
  tokenRequests: z.array(z.tuple([z.string(), time])),
  // [record identity, [[version or null (unknown/ambiguous), first acquisition time]]]
  acquisitions: z.array(z.tuple([z.string(), z.array(z.tuple([z.string().nullable(), time]))])).optional(),
  grants: z.array(z.object({
    grantId: z.string(), firstAcquiredAt: time, freshnessOrigin: time.nullable(), custodyOnly: z.boolean(),
    processingPermission: z.boolean(), lastPosition: z.number().int().nonnegative(),
    deletedAt: time.nullable(), deleteReason: z.string().nullable(), needsReconcile: z.boolean(),
    pendingDeletionReason: z.string().nullable(),
    // Added with per-record retention. Absent in older checkpoints: restored as untracked, so the
    // grant-level ceiling (never later than the record clocks) applies.
    readState: z.enum(["active", "window_closed", "expired", "ended"]).optional(),
    recordsTracked: z.boolean().optional(),
    legacyAcquiredAt: time.nullable().optional(),
    records: z.array(z.tuple([z.string(), z.object({ ref: refSchema, firstAcquiredAt: time })])).optional(),
    erasures: z.array(z.tuple([z.string(), z.object({
      scope: z.object({ streams: z.union([z.literal("all"), z.array(z.string())]) }),
      receivedAt: time, deleteBy: time, disposedAt: time.nullable(), receiptReported: z.boolean(),
      completionReported: z.boolean(), disposalPending: z.boolean(),
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
  #revision = 0;
  #highWaterMs: number;
  #clockUncertain = false;
  #stateUnavailable = false;
  #timeAnchor: { wall: number; mono: number } | null = null;
  /** Acquisition clocks survive grant changes and disposal; versions share identity only when ambiguous. */
  readonly #acquisitions = new Map<string, Map<string | undefined, number>>();
  #nextAttemptAt: number | null = null;
  readonly events: LifecycleEvent[] = [];

  constructor(o: {
    /** Caller supplies conservative epoch time; wall time alone is not a trusted time service. */
    now: () => number;
    status: StatusTransport;
    report?: ReportTransport;
    store: HeldStore;
    downstream?: Downstream[];
    policy?: Partial<LifecyclePolicy>;
    /** Confidential clients may ask about several grants in one call. */
    batch?: boolean;
    storage?: ClientCheckpointStorage;
    /** Explicitly initialize a pristine store; never use this when restoring held data. */
    initialize?: boolean;
    /** Like the lease guard: optionally detect wall/elapsed disagreement and suspension. */
    monotonicMs?: () => number;
  }) {
    this.policy = { ...DEFAULT_POLICY, ...o.policy };
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
        this.policy = cp.policy;
        this.#revision = cp.revision;
        this.#highWaterMs = cp.highWaterMs;
        this.#clockUncertain = cp.clockUncertain;
        this.#nextAttemptAt = cp.nextAttemptAt;
        for (const [id, origin] of cp.tokenOrigins) {
          this.#tokenOrigins.set(id, origin);
        }
        for (const [id, sentAt] of cp.tokenRequests) {
          this.#tokenRequests.set(id, sentAt);
        }
        for (const g of cp.grants) {
          this.#grants.set(g.grantId, {
            ...g,
            readState: g.readState ?? "active",
            recordsTracked: g.recordsTracked ?? false,
            legacyAcquiredAt: g.legacyAcquiredAt === undefined ? (g.recordsTracked ? null : g.firstAcquiredAt) : g.legacyAcquiredAt,
            records: new Map(g.records ?? []),
            erasures: new Map(g.erasures),
            needsReconcile: true,
          });
        }
        for (const [identity, versions] of cp.acquisitions ?? []) {
          this.#acquisitions.set(identity, new Map(versions.map(([v, at]) => [v ?? undefined, at])));
        }
      }
    } catch {
      this.#stateUnavailable = true;
    }
    this.#now();
  }

  /**
   * Record that data was acquired under a grant. Only the first call sets the
   * first-acquisition time; rereads and resyncs never move it. Record delivery
   * is not an assessment, so this never makes data usable.
   */
  acquire(grantId: string, o: { processingPermission?: boolean } = {}): boolean {
    const prior = this.#grants.get(grantId);
    // A legacy copy has no record identities, so reacquiring it after its ceiling cannot be told
    // from a new copy. The ceiling stays with the original acquisition.
    const ceilingClock = prior?.deletedAt != null && prior.deleteReason === "retention_ceiling" ? prior.legacyAcquiredAt : null;
    if (!this.#register(grantId, o)) return false;
    const g = this.#grants.get(grantId);
    if (!g) return false;
    g.legacyAcquiredAt = Math.min(g.legacyAcquiredAt ?? Number.POSITIVE_INFINITY, ceilingClock ?? Number.POSITIVE_INFINITY, g.firstAcquiredAt);
    if (this.policy.retentionCeilingMs !== null && this.#now() >= g.legacyAcquiredAt + this.policy.retentionCeilingMs) {
      // Nothing may be kept: dispose now and report that the caller must not store the copy.
      this.#disposeDue();
      return false;
    }
    return this.#persist();
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
    // A read after a long-stop or retention disposal is a new acquisition with
    // its own clocks; the ordering state is kept.
    if (!prior || prior.deletedAt !== null) {
      this.#grants.set(grantId, {
        grantId,
        readState: prior?.readState ?? "active",
        firstAcquiredAt: now,
        freshnessOrigin: this.#tokenOrigins.get(grantId)?.origin ?? null,
        custodyOnly: false,
        processingPermission: (o.processingPermission ?? false) || (this.#tokenOrigins.get(grantId)?.processingPermission ?? false),
        lastPosition: prior?.lastPosition ?? 0,
        erasures: prior?.erasures ?? new Map(),
        deletedAt: null,
        deleteReason: null,
        needsReconcile: false,
        pendingDeletionReason: null,
        recordsTracked: false,
        legacyAcquiredAt: null,
        records: new Map(),
      });
      this.#tokenOrigins.delete(grantId);
      this.#log(grantId, "acquire");
      // The first check is due 24 h after first acquisition.
      this.#nextAttemptAt = Math.min(this.#nextAttemptAt ?? Number.POSITIVE_INFINITY, now + this.policy.cadenceMs);
    }
    return true;
  }

  /** Record delivery per record; the returned set excludes copies whose retention already ended. */
  acquireRecords<T extends HeldRecordRef>(grantId: string, records: readonly T[]): T[] {
    if (this.policy.retentionCeilingMs !== null && !this.#store.disposeRecords) {
      throw new Error("per-record retention requires a store with disposeRecords");
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
      for (const ref of this.#store.recordRefs(grantId)) {
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
      priorGrant.recordsTracked = true;
      priorGrant.legacyAcquiredAt = null;
    }
    const eligible: { ref: T; key: string; firstAcquiredAt: number }[] = [];
    for (const ref of records) {
      const identity = JSON.stringify([ref.sourceId ?? null, ref.instanceId ?? null, ref.stream, ref.id]);
      const versions = this.#acquisitions.get(identity) ?? new Map<string | undefined, number>();
      const prior = ref.version === undefined
        ? Math.min(now, ...versions.values())
        : Math.min(now, versions.get(ref.version) ?? now, versions.get(undefined) ?? now);
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
    return this.#persist() ? eligible.map((r) => r.ref) : [];
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
    if (g.freshnessOrigin === null) {
      return { ok: false, reason: "no_assessment" };
    }
    const until = g.freshnessOrigin + this.policy.pauseThresholdMs;
    if (this.#highWaterMs >= until) {
      return { ok: false, reason: "stale" };
    }
    if (!this.#persist()) {
      return { ok: false, reason: "state_unavailable" };
    }
    // Durable writes take time. Sample once more, with no I/O after it, so a write that
    // crossed a deadline cannot license use past it.
    const written = this.#now();
    if (this.#clockUncertain) {
      return { ok: false, reason: "state_unavailable" };
    }
    const due = this.deleteBy(grantId);
    if (written >= until || (due !== null && written >= due)) {
      this.#disposeDue(written);
      return { ok: false, reason: this.#grants.get(grantId)?.deletedAt != null ? "deleted" : "stale" };
    }
    return { ok: true, until };
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
    if (this.policy.longStopMs !== null) {
      candidates.push((g.freshnessOrigin ?? g.firstAcquiredAt) + this.policy.longStopMs);
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
        g.freshnessOrigin = Math.max(g.freshnessOrigin ?? -Infinity, sentAt);
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

  /** Run due work: overdue disposal first, then a status attempt if one is due. */
  async tick(): Promise<void> {
    this.#disposeDue();
    const now = this.#now();
    if (this.#nextAttemptAt !== null && now >= this.#nextAttemptAt) {
      await this.reconcile();
    }
    this.#persist();
  }

  /** A read failed with the grant shown inactive: check status before further use. */
  async onReadFailure(grantId: string): Promise<void> {
    const g = this.#grants.get(grantId);
    if (g) {
      g.needsReconcile = true;
    }
    this.#persist();
    await this.reconcile();
  }

  /** After a suspend or restart: dispose of anything overdue, then reconcile before any use. */
  async onResume(): Promise<void> {
    for (const g of this.#grants.values()) {
      g.needsReconcile = true;
    }
    this.#persist();
    this.#disposeDue();
    await this.reconcile();
  }

  /**
   * The owner asked the client directly to delete (K9). That is receipt: the
   * clock starts now, whether or not the AS hears.
   */
  ownerDelete(grantId: string): void {
    this.#receiveErasure(grantId, `local_${grantId}_${this.#now()}`, { streams: "all" });
    this.#relayAll();
    this.#disposeDue();
  }

  /** Attempt status for every held grant now. */
  async reconcile(): Promise<void> {
    // Overdue disposal comes before any new assessment, on every entry path.
    this.#disposeDue();
    if (this.#stateUnavailable || this.#clockUncertain) {
      return;
    }
    const held = [...this.#grants.values()].filter((g) => g.deletedAt === null).map((g) => g.grantId);
    const sentAt = this.#now();
    if (held.length === 0) {
      this.#nextAttemptAt = null;
      this.#persist();
      return;
    }
    let failed = false;
    let retryAfterMs = 0;
    const groups = this.#batch ? [held] : held.map((id) => [id]);
    for (const ids of groups) {
      let r: Awaited<ReturnType<StatusTransport>>;
      try {
        r = await this.#status(ids);
      } catch (err) {
        r = { ok: false, reason: err instanceof Error ? err.message : "unreachable" };
      }
      // A deadline may have passed while the response was in flight. Dispose
      // against the old assessment before the new one can move the long-stop.
      this.#disposeDue();
      if (this.#stateUnavailable || this.#clockUncertain) {
        return;
      }
      if (!r.ok) {
        failed = true;
        retryAfterMs = Math.max(retryAfterMs, r.retryAfterMs ?? 0);
        for (const id of ids) {
          this.#log(id, "status_failed", r.reason);
        }
        continue;
      }
      // A grant counts as answered only with exactly one lifecycle answer for
      // it. A per-grant error, a missing entry or a duplicate is a failed
      // attempt for that grant, retried within the retry interval.
      for (const id of ids) {
        const entries = r.results.filter((x) => x.grant_id === id);
        const only = entries.length === 1 ? entries[0] : undefined;
        if (!only || "error" in only) {
          failed = true;
          this.#log(id, "status_failed", only && "error" in only ? only.error : "no_answer");
          continue;
        }
        this.#apply(only, sentAt);
        if (!this.#persist()) {
          return;
        }
      }
    }
    // The attempt was made; the threshold rule now governs use.
    for (const id of held) {
      const g = this.#grants.get(id);
      if (g) {
        g.needsReconcile = false;
      }
    }
    // The interval runs between attempt starts, so a slow answer does not stretch it.
    this.#nextAttemptAt = sentAt + (failed ? Math.max(this.policy.retryMs, retryAfterMs) : this.policy.cadenceMs);
    if (!this.#persist()) {
      return;
    }
    this.#disposeDue();
    this.#relayAll();
  }

  get nextAttemptAt(): number | null {
    return this.#nextAttemptAt;
  }

  #apply(res: StatusResult, sentAt: number): void {
    const g = this.#grants.get(res.grant_id);
    if (!g) {
      return;
    }
    if ("error" in res) {
      // Unknown, foreign and lost grants look the same by design. No positive
      // assessment: use pauses at the threshold.
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
      this.#receiveErasure(g.grantId, e.operation_id, e.scope);
    }
    g.custodyOnly = res.ordinary_use === "custody_only";
    // Custody-only is still a positive assessment: it refreshes the origin
    // (and so the long-stop) even though it permits no use.
    if (res.ordinary_use !== "stopped") {
      const origin =
        this.policy.freshnessOrigin === "request_sent" ? Math.min(res.assessed_at, sentAt) : res.assessed_at;
      // Never moved backwards by an older (delayed or replayed) answer.
      g.freshnessOrigin = Math.max(g.freshnessOrigin ?? Number.NEGATIVE_INFINITY, origin);
      this.#log(g.grantId, "positive", String(origin));
    }
  }

  #receiveErasure(grantId: string, operationId: string, scope: ErasureScope): void {
    const g = this.#grants.get(grantId);
    if (!g || g.erasures.has(operationId)) {
      // Redelivery never restarts a clock.
      return;
    }
    const now = this.#now();
    g.erasures.set(operationId, {
      scope,
      receivedAt: now,
      deleteBy: now + this.policy.deletionPeriodMs,
      disposedAt: null,
      receiptReported: false,
      completionReported: false,
      disposalPending: false,
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
        this.#store.dispose(g.grantId, { streams: "all" });
        continue;
      }
      for (const [opId, e] of g.erasures) {
        if (e.disposedAt !== null) {
          // The library also models partial scopes: replay them against restored
          // data even though the original disposal is already recorded complete.
          this.#store.dispose(g.grantId, e.scope);
          continue;
        }
        const due = e.disposalPending || this.policy.disposeAt === "promptly" || now >= e.deleteBy;
        if (e.disposedAt === null && due) {
          e.disposalPending = true;
          if (!this.#persist()) {
            this.#store.dispose(g.grantId, e.scope);
            return;
          }
          this.#store.dispose(g.grantId, e.scope);
          e.disposedAt = now;
          e.disposalPending = false;
          this.#log(g.grantId, "disposed", opId);
          if (e.scope.streams === "all") {
            g.deletedAt = now;
            g.deleteReason = "erasure";
            g.records.clear();
          }
          if (this.#persist()) {
            void this.#reportOp(g.grantId, opId, "completion");
          }
        }
      }
      if (g.deletedAt !== null) {
        continue;
      }
      const grantDeadlines: number[] = [];
      if (this.policy.longStopMs !== null) {
        grantDeadlines.push((g.freshnessOrigin ?? g.firstAcquiredAt) + this.policy.longStopMs);
      }
      if (g.legacyAcquiredAt !== null && this.policy.retentionCeilingMs !== null) {
        grantDeadlines.push(g.legacyAcquiredAt + this.policy.retentionCeilingMs);
      }
      // Per-record ceilings never use the grant's first acquisition: a later record keeps its own clock.
      const by = grantDeadlines.length ? Math.min(...grantDeadlines) : null;
      if (g.pendingDeletionReason !== null || (by !== null && now >= by)) {
        g.pendingDeletionReason ??=
          g.legacyAcquiredAt !== null && this.policy.retentionCeilingMs !== null && now >= g.legacyAcquiredAt + this.policy.retentionCeilingMs
            ? "retention_ceiling"
            : "long_stop";
        if (!this.#persist()) {
          this.#store.dispose(g.grantId, { streams: "all" });
          return;
        }
        this.#store.dispose(g.grantId, { streams: "all" });
        g.deletedAt = now;
        g.deleteReason = g.pendingDeletionReason;
        g.pendingDeletionReason = null;
        g.records.clear();
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

  async #reportOp(grantId: string, operationId: string, kind: "receipt" | "completion"): Promise<void> {
    const e = this.#grants.get(grantId)?.erasures.get(operationId);
    if (!(this.#report && e) || operationId.startsWith("local_") || !this.#persist()) {
      return;
    }
    try {
      const ok = await this.#report({
        grantId,
        operationId,
        kind,
        reportedAt: kind === "receipt" ? e.receivedAt : (e.disposedAt ?? this.#now()),
        ...(kind === "completion" ? { outcome: "deleted" } : {}),
      });
      if (ok && kind === "receipt") {
        e.receiptReported = true;
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
        useUntil: decision.ok ? decision.until : null,
        erasures: [...g.erasures].map(([operationId, e]) => ({ operationId, scope: e.scope, deleteBy: e.deleteBy })),
        deleteAllBy: this.deleteBy(g.grantId),
      };
      for (const d of this.#downstream) {
        // A preceding callback or the issuedAt reading can expose a clock
        // discontinuity. Recheck immediately before licensing downstream use.
        const current = this.canUse(g.grantId);
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
        for (const g of this.#grants.values()) {
          g.needsReconcile = true;
        }
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

  #persist(): boolean {
    if (this.#stateUnavailable) {
      return false;
    }
    try {
      this.#storage.write(JSON.stringify({
        version: 1, revision: ++this.#revision, policy: this.policy,
        highWaterMs: this.#highWaterMs, clockUncertain: this.#clockUncertain, nextAttemptAt: this.#nextAttemptAt,
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
        this.#store.dispose(id, { streams: "all" });
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
