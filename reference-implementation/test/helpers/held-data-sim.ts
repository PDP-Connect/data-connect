// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fake-clock simulation for the held-data lifecycle prototype: one AS
 * authority, one client with the toy app and a toy subprocessor, an in-process
 * status transport whose reachability and delay the test controls, and a
 * stepper that records exactly when use stops and data is disposed.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { ToyApp, ToySubprocessor } from "../../examples/held-data-toy-app/app.ts";
import {
  AuthorityUnavailableError,
  HeldDataAuthority,
  type StatusResult,
} from "../../lib/held-data/authority.ts";
import { HeldDataClient, type LifecyclePolicy } from "../../lib/held-data/client.ts";

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 9, 12, 0, 0, 0);

const dirs: string[] = [];
after(() => {
  for (const d of dirs) {
    rmSync(d, { force: true, recursive: true });
  }
});

export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export interface SimOptions {
  policy?: Partial<LifecyclePolicy>;
  /** AS clock offset from true time (skew). */
  asSkewMs?: number;
  grants?: string[];
  confidential?: boolean;
}

export class Sim {
  t = T0;
  readonly journalPath: string;
  readonly epochPath: string;
  readonly as: HeldDataAuthority;
  readonly app = new ToyApp();
  readonly sub: ToySubprocessor;
  readonly client: HeldDataClient;
  readonly tokens = new Map<string, string>();
  /** True time windows during which the AS cannot be reached. */
  outages: [number, number][] = [];
  /** Extra delay before the client receives an answer (the answer is assessed at send time). */
  responseDelayMs = 0;
  asSkewMs: number;
  /** When set, answers come from this authority instead (e.g. a stale replica). */
  answerFrom: HeldDataAuthority | null = null;
  statusCalls = 0;

  constructor(o: SimOptions = {}) {
    const dir = tempDir("pdpp-held-sim-");
    this.journalPath = join(dir, "authority.journal");
    this.epochPath = join(dir, "authority-epoch");
    this.asSkewMs = o.asSkewMs ?? 0;
    this.as = HeldDataAuthority.open({
      journalPath: this.journalPath,
      now: () => this.t + this.asSkewMs,
      epochMarkerPath: this.epochPath,
    });
    this.sub = new ToySubprocessor(() => this.t);
    this.client = new HeldDataClient({
      now: () => this.t,
      store: this.app,
      downstream: [this.sub],
      policy: o.policy ?? {},
      status: (ids) => this.#status(ids),
      report: async (r) => {
        if (!this.reachable()) {
          return false;
        }
        return this.as.report({ clientId: "app", ...r });
      },
    });
    this.app.attach(this.client);
    for (const g of o.grants ?? ["g1"]) {
      this.addGrant(g, o.confidential ?? false);
    }
  }

  addGrant(grantId: string, confidential = false, opts: { trainingOnly?: boolean; expiresAtMs?: number | null } = {}) {
    this.as.registerGrant({
      grantId,
      clientId: "app",
      subjectId: "owner",
      confidential,
      trainingOnly: opts.trainingOnly ?? false,
      streams: ["messages", "contacts"],
      expiresAtMs: opts.expiresAtMs ?? null,
    });
    const token = `at_${grantId}_${Math.random().toString(36).slice(2)}`;
    this.as.recordCredential({ token, grantIds: [grantId], kind: "access" });
    this.tokens.set(grantId, token);
  }

  reachable(at = this.t): boolean {
    return !this.outages.some(([a, b]) => at >= a && at < b);
  }

  async #status(ids: readonly string[]) {
    this.statusCalls += 1;
    if (!this.reachable()) {
      return { ok: false as const, reason: "unreachable" };
    }
    const authority = this.answerFrom ?? this.as;
    let results: StatusResult[] = [];
    try {
      results = ids.flatMap((id) => {
        const principal = authority.authenticateRead({ token: this.tokens.get(id) ?? null });
        return principal ? authority.status(principal, [id]) : [{ grant_id: id, error: "invalid_grant" as const }];
      });
    } catch (err) {
      if (err instanceof AuthorityUnavailableError) {
        return { ok: false as const, reason: "unavailable" };
      }
      throw err;
    }
    if (this.responseDelayMs > 0) {
      this.t += this.responseDelayMs;
    }
    return { ok: true as const, results };
  }

  /** Sync records into the app (and hand a copy to the subprocessor). */
  sync(grantId = "g1") {
    this.app.sync(grantId, [
      { id: "r1", stream: "messages", text: "hello world" },
      { id: "r2", stream: "contacts", text: "alice bob" },
    ]);
    this.sub.receive(grantId, 2);
  }

  /**
   * Advance true time to `until` in `step`s, ticking the client and the
   * subprocessor. Returns the last instant the app could use each grant and
   * when the copy was gone.
   */
  async runUntil(until: number, step = 15 * MIN, grantId = "g1") {
    let lastUsable: number | null = null;
    let lastSubUsable: number | null = null;
    while (this.t < until) {
      this.t = Math.min(until, this.t + step);
      await this.client.tick();
      this.sub.tick();
      if (this.client.canUse(grantId).ok) {
        lastUsable = this.t;
      }
      if (this.sub.canUse(grantId)) {
        lastSubUsable = this.t;
      }
    }
    return { lastUsable, lastSubUsable };
  }

  /** First instant (at step resolution) at which the app holds nothing for the grant. */
  async runUntilGone(limit: number, step = HOUR, grantId = "g1"): Promise<number | null> {
    while (this.t < limit) {
      this.t = Math.min(limit, this.t + step);
      await this.client.tick();
      this.sub.tick();
      const h = this.app.holds(grantId);
      if (h.records === 0 && h.indexEntries === 0 && !h.summary) {
        return this.t;
      }
    }
    return null;
  }
}
