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
import type { Downstream, DownstreamNotice, HeldDataClient, HeldStore } from "../../lib/held-data/client.ts";

export interface ToyRecord {
  id: string;
  stream: string;
  text: string;
}

export class ToyApp implements HeldStore {
  readonly records = new Map<string, ToyRecord[]>();
  /** Derivative: word -> record ids. */
  readonly index = new Map<string, Set<string>>();
  /** Derivative: grant -> record count summary. */
  readonly summaries = new Map<string, string>();
  #client: HeldDataClient | null = null;

  attach(client: HeldDataClient): void {
    this.#client = client;
  }

  /** Store records from a read. Rereads replace the copy; they never move lifecycle clocks. */
  sync(grantId: string, records: ToyRecord[]): void {
    this.#client?.acquire(grantId);
    const prior = this.records.get(grantId) ?? [];
    const merged = new Map(prior.map((r) => [r.id, r]));
    for (const r of records) {
      merged.set(r.id, r);
    }
    this.records.set(grantId, [...merged.values()]);
    this.reindex(grantId);
  }

  /** A transform. Rebuilds derivatives; lifecycle clocks are not touched. */
  reindex(grantId: string): void {
    for (const ids of this.index.values()) {
      for (const id of [...ids]) {
        if (id.startsWith(`${grantId}:`)) {
          ids.delete(id);
        }
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
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  receive(grantId: string, count: number): void {
    this.held.set(grantId, count);
  }

  relay(n: DownstreamNotice): void {
    this.notices.push(structuredClone(n));
  }

  latest(grantId: string): DownstreamNotice | undefined {
    return this.notices.filter((n) => n.grantId === grantId).at(-1);
  }

  canUse(grantId: string): boolean {
    const n = this.latest(grantId);
    return this.held.has(grantId) && n?.useUntil != null && this.#now() < n.useUntil;
  }

  /** Dispose of everything whose relayed deadline has passed. */
  tick(): void {
    for (const grantId of [...this.held.keys()]) {
      const n = this.latest(grantId);
      const deadlines = [n?.deleteAllBy, ...(n?.erasures.map((e) => e.deleteBy) ?? [])].filter(
        (x): x is number => typeof x === "number"
      );
      if (deadlines.some((d) => this.#now() >= d)) {
        this.held.delete(grantId);
      }
    }
  }
}
