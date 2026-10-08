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
import type { ErasureScope, StatusResult } from "./authority.ts";

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
) => Promise<{ ok: true; results: StatusResult[] } | { ok: false; reason: string }>;

/** Client writes (receipt, completion). Need current client authentication. */
export type ReportTransport = (r: {
  grantId: string;
  operationId: string;
  kind: "receipt" | "completion";
  outcome?: "deleted" | "exception";
  /** Client time of the event: first receipt, or completion. */
  reportedAt?: number;
}) => Promise<boolean>;

/** Where the app keeps the copy and its derivatives. */
export interface HeldStore {
  /** Remove the covered records and every derivative built from them. */
  dispose(grantId: string, scope: ErasureScope): void;
}

/** K8: what a downstream holder receives. Absolute times only. */
export interface DownstreamNotice {
  grantId: string;
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
      reason: "deleted" | "erased" | "no_assessment" | "stale" | "reconcile_required" | "custody_only";
    };

interface HeldErasure {
  scope: ErasureScope;
  receivedAt: number;
  deleteBy: number;
  disposedAt: number | null;
  receiptReported: boolean;
  completionReported: boolean;
}

interface HeldGrant {
  grantId: string;
  firstAcquiredAt: number;
  freshnessOrigin: number | null;
  custodyOnly: boolean;
  lastPosition: number;
  erasures: Map<string, HeldErasure>;
  deletedAt: number | null;
  deleteReason: string | null;
  needsReconcile: boolean;
}

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
  #nextAttemptAt: number | null = null;
  readonly events: LifecycleEvent[] = [];

  constructor(o: {
    now: () => number;
    status: StatusTransport;
    report?: ReportTransport;
    store: HeldStore;
    downstream?: Downstream[];
    policy?: Partial<LifecyclePolicy>;
    /** Confidential clients may ask about several grants in one call. */
    batch?: boolean;
  }) {
    this.policy = { ...DEFAULT_POLICY, ...o.policy };
    this.#now = o.now;
    this.#status = o.status;
    this.#report = o.report ?? null;
    this.#store = o.store;
    this.#downstream = o.downstream ?? [];
    this.#batch = o.batch ?? false;
  }

  /**
   * Record that data was acquired under a grant. Only the first call sets the
   * first-acquisition time; rereads and resyncs never move it. Record delivery
   * is not an assessment, so this never makes data usable.
   */
  acquire(grantId: string): void {
    const now = this.#now();
    if (!this.#grants.has(grantId)) {
      this.#grants.set(grantId, {
        grantId,
        firstAcquiredAt: now,
        freshnessOrigin: null,
        custodyOnly: false,
        lastPosition: 0,
        erasures: new Map(),
        deletedAt: null,
        deleteReason: null,
        needsReconcile: false,
      });
      this.#log(grantId, "acquire");
      // The first check is due 24 h after first acquisition.
      this.#nextAttemptAt = Math.min(this.#nextAttemptAt ?? Number.POSITIVE_INFINITY, now + this.policy.cadenceMs);
    }
  }

  /** The gate the app checks before every use. */
  canUse(grantId: string): UseDecision {
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
    if (g.custodyOnly) {
      return { ok: false, reason: "custody_only" };
    }
    if (g.freshnessOrigin === null) {
      return { ok: false, reason: "no_assessment" };
    }
    const until = g.freshnessOrigin + this.policy.pauseThresholdMs;
    if (this.#now() >= until) {
      return { ok: false, reason: "stale" };
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
      candidates.push(g.firstAcquiredAt + this.policy.retentionCeilingMs);
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
    return this.#grants.get(grantId);
  }

  /** Run due work: overdue disposal first, then a status attempt if one is due. */
  async tick(): Promise<void> {
    this.#disposeDue();
    const now = this.#now();
    if (this.#nextAttemptAt !== null && now >= this.#nextAttemptAt) {
      await this.reconcile();
    }
  }

  /** A read failed with the grant shown inactive: check status before further use. */
  async onReadFailure(grantId: string): Promise<void> {
    const g = this.#grants.get(grantId);
    if (g) {
      g.needsReconcile = true;
    }
    await this.reconcile();
  }

  /** After a suspend or restart: dispose of anything overdue, then reconcile before any use. */
  async onResume(): Promise<void> {
    for (const g of this.#grants.values()) {
      g.needsReconcile = true;
    }
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
    const held = [...this.#grants.values()].filter((g) => g.deletedAt === null).map((g) => g.grantId);
    const sentAt = this.#now();
    if (held.length === 0) {
      this.#nextAttemptAt = null;
      return;
    }
    let failed = false;
    const groups = this.#batch ? [held] : held.map((id) => [id]);
    for (const ids of groups) {
      let r: Awaited<ReturnType<StatusTransport>>;
      try {
        r = await this.#status(ids);
      } catch (err) {
        r = { ok: false, reason: err instanceof Error ? err.message : "unreachable" };
      }
      if (!r.ok) {
        failed = true;
        for (const id of ids) {
          this.#log(id, "status_failed", r.reason);
        }
        continue;
      }
      for (const res of r.results) {
        this.#apply(res, sentAt);
      }
    }
    // The attempt was made; the threshold rule now governs use.
    for (const id of held) {
      const g = this.#grants.get(id);
      if (g) {
        g.needsReconcile = false;
      }
    }
    const now = this.#now();
    this.#nextAttemptAt = now + (failed ? this.policy.retryMs : this.policy.cadenceMs);
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
    for (const e of res.erasures) {
      this.#receiveErasure(g.grantId, e.operation_id, e.scope);
    }
    g.custodyOnly = res.ordinary_use === "custody_only";
    if (res.ordinary_use === "permitted") {
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
    });
    this.#log(grantId, "erasure_received", operationId);
    void this.#reportOp(grantId, operationId, "receipt");
  }

  #disposeDue(): void {
    const now = this.#now();
    for (const g of this.#grants.values()) {
      if (g.deletedAt !== null) {
        continue;
      }
      for (const [opId, e] of g.erasures) {
        const due = this.policy.disposeAt === "promptly" || now >= e.deleteBy;
        if (e.disposedAt === null && due) {
          this.#store.dispose(g.grantId, e.scope);
          e.disposedAt = now;
          this.#log(g.grantId, "disposed", opId);
          void this.#reportOp(g.grantId, opId, "completion");
          if (e.scope.streams === "all") {
            g.deletedAt = now;
            g.deleteReason = "erasure";
          }
        }
      }
      if (g.deletedAt !== null) {
        continue;
      }
      const by = this.deleteBy(g.grantId);
      if (by !== null && now >= by) {
        this.#store.dispose(g.grantId, { streams: "all" });
        g.deletedAt = now;
        g.deleteReason =
          this.policy.retentionCeilingMs !== null && now >= g.firstAcquiredAt + this.policy.retentionCeilingMs
            ? "retention_ceiling"
            : "long_stop";
        this.#log(g.grantId, "disposed", g.deleteReason);
      }
    }
  }

  async #reportOp(grantId: string, operationId: string, kind: "receipt" | "completion"): Promise<void> {
    const e = this.#grants.get(grantId)?.erasures.get(operationId);
    if (!(this.#report && e) || operationId.startsWith("local_")) {
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
    } catch {
      // Retried on the next reconcile is not built; the AS then shows the operation as delivered but unconfirmed.
    }
  }

  #relayAll(): void {
    for (const g of this.#grants.values()) {
      const decision = this.canUse(g.grantId);
      const notice: DownstreamNotice = {
        grantId: g.grantId,
        useUntil: decision.ok ? decision.until : null,
        erasures: [...g.erasures].map(([operationId, e]) => ({ operationId, scope: e.scope, deleteBy: e.deleteBy })),
        deleteAllBy: this.deleteBy(g.grantId),
      };
      for (const d of this.#downstream) {
        d.relay(notice);
      }
    }
  }

  #log(grantId: string, kind: LifecycleEvent["kind"], detail?: string): void {
    this.events.push({ at: this.#now(), grantId, kind, ...(detail === undefined ? {} : { detail }) });
  }
}
