// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Toy app for the held-data lifecycle prototype.
 *
 * It keeps a synced copy of records per grant plus two derivatives: a word
 * index and a per-grant summary. Every use goes through the lifecycle gate.
 * Disposal removes the records and both derivatives. A toy subprocessor holds
 * its own copy and obeys only the absolute times the app relays (K8).
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import type { ErasureScope } from "../../lib/held-data/authority.ts";
import type { Downstream, DownstreamNotice, HeldDataClient, HeldRecordRef, HeldStore } from "../../lib/held-data/client.ts";

export interface ToyRecord extends HeldRecordRef {
  id: string;
  stream: string;
  text: string;
}

/** One unit of use of a grant's data: queued, running (in flight), then done or cancelled. */
export interface ToyJob {
  readonly grantId: string;
  readonly word: string;
  state: "queued" | "running" | "done" | "cancelled";
}

/** Adapter observation on the declared test clock (Core C2). */
export interface ToyJobObservation {
  kind: "queued" | "start" | "cancel" | "complete";
  grantId: string;
  at: number;
}

export class ToyApp implements HeldStore {
  readonly records = new Map<string, ToyRecord[]>();
  /** Derivative: word -> record ids. */
  readonly index = new Map<string, Set<string>>();
  /** Derivative: grant -> record count summary. */
  readonly summaries = new Map<string, string>();
  /** Derivative over several grants: the record keys of every input grant, rebuilt whenever one changes. */
  readonly digests = new Map<string, { grants: string[]; entries: string[] }>();
  /** Receipt, cancellation and completion of queued and in-flight work. */
  readonly observations: ToyJobObservation[] = [];
  readonly #jobs: ToyJob[] = [];
  readonly #clock: () => number;
  #client: HeldDataClient | null = null;

  constructor(clock: () => number = () => 0) {
    this.#clock = clock;
  }

  attach(client: HeldDataClient): void {
    this.#client = client;
  }

  /** Queue work. Queuing is not use; the gate applies when it starts and when it completes. */
  enqueue(grantId: string, word: string): ToyJob {
    const job: ToyJob = { grantId, word, state: "queued" };
    this.#jobs.push(job);
    this.#observe("queued", grantId);
    return job;
  }

  /** Dispatch a queued job. The gate is checked at dispatch. */
  start(job: ToyJob): boolean {
    if (job.state !== "queued") {
      return false;
    }
    if (!this.#client?.canUse(job.grantId).ok) {
      this.#cancel(job);
      return false;
    }
    job.state = "running";
    this.#observe("start", job.grantId);
    return true;
  }

  /** Finish in-flight work. Completing is use: the gate is checked again, so old eligibility never carries over. */
  finish(job: ToyJob): string[] | null {
    if (job.state !== "running") {
      return null;
    }
    const result = this.search(job.grantId, job.word);
    if (result === null) {
      this.#cancel(job);
      return null;
    }
    job.state = "done";
    this.#observe("complete", job.grantId);
    return result;
  }

  #cancel(job: ToyJob): void {
    job.state = "cancelled";
    this.#observe("cancel", job.grantId);
  }

  #observe(kind: ToyJobObservation["kind"], grantId: string): void {
    this.observations.push({ kind, grantId, at: this.#clock() });
  }

  grantIds(): Iterable<string> {
    const ids = new Set([...this.records.keys(), ...this.summaries.keys()]);
    for (const entries of this.index.values()) {
      for (const key of entries) ids.add(key.slice(0, key.lastIndexOf(":")));
    }
    return ids;
  }

  recordRefs(grantId: string): Iterable<HeldRecordRef> {
    return this.records.get(grantId) ?? [];
  }

  /** Store records from a read. Rereads replace the copy; they never move lifecycle clocks. */
  sync(grantId: string, records: ToyRecord[]): void {
    if (this.#client) {
      records = this.#client.acquireRecords(grantId, records);
      if (records.length === 0) {
        // A late delivery under an erased grant is dropped, not stored.
        // The same applies to a version whose retention ceiling passed.
        return;
      }
    }
    const erased = this.#client?.erasedStreams(grantId) ?? new Set<string>();
    const prior = (this.records.get(grantId) ?? []).filter((r) => !erased.has(r.stream));
    const merged = new Map(prior.map((r) => [r.id, r]));
    for (const r of records) {
      if (!erased.has(r.stream)) {
        merged.set(r.id, r);
      }
    }
    this.records.set(grantId, [...merged.values()]);
    this.reindex(grantId);
  }

  /** A transform. Rebuilds derivatives; lifecycle clocks are not touched. */
  reindex(grantId: string): void {
    for (const [word, ids] of this.index) {
      for (const id of [...ids]) {
        if (id.startsWith(`${grantId}:`)) {
          ids.delete(id);
        }
      }
      if (ids.size === 0) {
        this.index.delete(word);
      }
    }
    for (const r of this.records.get(grantId) ?? []) {
      for (const w of r.text.toLowerCase().split(/\W+/).filter(Boolean)) {
        const set = this.index.get(w) ?? new Set<string>();
        set.add(`${grantId}:${r.id}`);
        this.index.set(w, set);
      }
    }
    this.summaries.set(grantId, `${this.records.get(grantId)?.length ?? 0} records`);
    this.#rebuildDigests();
  }

  /** Create a derivative from the records of several grants. */
  buildDigest(name: string, grants: string[]): void {
    this.digests.set(name, { grants, entries: [] });
    this.#rebuildDigests();
  }

  #rebuildDigests(): void {
    for (const [name, d] of this.digests) {
      d.entries = d.grants.flatMap((g) => (this.records.get(g) ?? []).map((r) => `${g}:${r.id}`));
      if (d.entries.length === 0) {
        this.digests.delete(name);
      }
    }
  }

  /** An ordinary use: search. Returns null when the gate refuses. */
  search(grantId: string, word: string): string[] | null {
    if (!this.#client?.canUse(grantId).ok) {
      return null;
    }
    const erased = this.#client.erasedStreams(grantId);
    const recs = this.records.get(grantId) ?? [];
    const hits = [...(this.index.get(word.toLowerCase()) ?? [])].filter((k) => k.startsWith(`${grantId}:`));
    return hits.filter((k) => {
      const r = recs.find((x) => `${grantId}:${x.id}` === k);
      return r !== undefined && !erased.has(r.stream);
    });
  }

  dispose(grantId: string, scope: ErasureScope): void {
    if (scope.streams === "all") {
      // Disposal stops work that has not completed.
      for (const job of this.#jobs) {
        if (job.grantId === grantId && (job.state === "queued" || job.state === "running")) {
          this.#cancel(job);
        }
      }
    }
    const recs = this.records.get(grantId) ?? [];
    const keep = scope.streams === "all" ? [] : recs.filter((r) => !(scope.streams as string[]).includes(r.stream));
    if (keep.length === 0) {
      this.records.delete(grantId);
    } else {
      this.records.set(grantId, keep);
    }
    this.reindex(grantId);
    if (keep.length === 0) {
      this.summaries.delete(grantId);
    }
  }

  disposeRecords(grantId: string, records: readonly HeldRecordRef[]): void {
    const current = this.records.get(grantId) ?? [];
    const keep = current.filter((r) => !records.some((expired) =>
      expired.id === r.id && expired.stream === r.stream && expired.version === r.version
    ));
    if (keep.length) {
      this.records.set(grantId, keep);
    } else {
      this.records.delete(grantId);
    }
    // A mixed summary/index is regenerated without the expired inputs.
    this.reindex(grantId);
    if (keep.length === 0) {
      this.summaries.delete(grantId);
    }
  }

  /** Everything still held for a grant, including derivatives. */
  holds(grantId: string): { records: number; indexEntries: number; summary: boolean } {
    let indexEntries = 0;
    for (const ids of this.index.values()) {
      for (const id of ids) {
        if (id.startsWith(`${grantId}:`)) {
          indexEntries += 1;
        }
      }
    }
    return {
      records: this.records.get(grantId)?.length ?? 0,
      indexEntries,
      summary: this.summaries.has(grantId),
    };
  }
}

/** A downstream holder. Its own clock; it acts only on absolute times it was sent. */
export class ToySubprocessor implements Downstream {
  readonly notices: DownstreamNotice[] = [];
  readonly held = new Map<string, number>();
  readonly #read: () => number;
  #highWaterMs = Number.NEGATIVE_INFINITY;

  constructor(now: () => number) {
    this.#read = now;
  }

  /** High-water mark, as in the main client: a clock moved back never revives use or delays disposal. */
  #now(): number {
    const raw = this.#read();
    if (Number.isFinite(raw)) {
      this.#highWaterMs = Math.max(this.#highWaterMs, raw);
    }
    return this.#highWaterMs;
  }

  receive(grantId: string, count: number): void {
    this.held.set(grantId, count);
  }

  relay(n: DownstreamNotice): void {
    this.notices.push(structuredClone(n));
  }

  /** The most recently issued notice (delivery can be reordered). */
  latest(grantId: string): DownstreamNotice | undefined {
    const mine = this.notices.filter((n) => n.grantId === grantId);
    return mine.reduce<DownstreamNotice | undefined>(
      (best, n) => (best === undefined || (n.issuedAt ?? -Infinity) >= (best.issuedAt ?? -Infinity) ? n : best),
      undefined
    );
  }

  /**
   * Terminal facts merged over every notice ever received: an erasure is never
   * forgotten, and each deadline is the earliest one relayed.
   */
  terminal(grantId: string): { erased: boolean; deleteBy: number | null } {
    let erased = false;
    let deleteBy: number | null = null;
    for (const n of this.notices.filter((x) => x.grantId === grantId)) {
      for (const d of [n.deleteAllBy, ...n.erasures.map((e) => e.deleteBy)]) {
        if (typeof d === "number") {
          deleteBy = deleteBy === null ? d : Math.min(deleteBy, d);
        }
      }
      erased ||= n.erasures.some((e) => e.scope.streams === "all");
    }
    return { erased, deleteBy };
  }

  canUse(grantId: string): boolean {
    const n = this.latest(grantId);
    const now = this.#now();
    const { erased, deleteBy } = this.terminal(grantId);
    // The gate enforces every relayed deadline itself; it does not rely on a later tick.
    return this.held.has(grantId) && !erased && (deleteBy === null || now < deleteBy) && n?.useUntil != null && now < n.useUntil;
  }

  /** Dispose of everything whose relayed deadline has passed. */
  tick(): void {
    for (const grantId of [...this.held.keys()]) {
      const { deleteBy } = this.terminal(grantId);
      if (deleteBy !== null && this.#now() >= deleteBy) {
        this.held.delete(grantId);
      }
    }
  }
}
