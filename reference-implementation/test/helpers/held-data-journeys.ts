// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A scripted world for the held-data journeys: the real AS app over HTTP with an injected clock, a
 * public client built from the client library and the toy app, and a network the test can cut.
 * Every request the client makes is logged. PROTOTYPE.
 */
import assert from "node:assert/strict";
import { ToyApp } from "../../examples/held-data-toy-app/app.ts";
import { MemoryClientCheckpointStorage } from "../../lib/held-data/checkpoint.ts";
import { HeldDataClient, type LegalRetentionSpec, type LifecyclePolicy } from "../../lib/held-data/client.ts";
import { httpReportTransport, httpStatusTransport } from "../../lib/held-data/http-transport.ts";
import { fetchJson, type Harness, withServer } from "./training-lease-harness.ts";
import {
  authCodeGrant,
  heldDataOpts,
  owner,
  registerPublicClient,
  rsRead,
} from "./held-data-as-http.ts";
import { recoverLifecycle } from "./held-data-recovery-flow.ts";

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export interface Call {
  at: number;
  kind: "query" | "write";
  /** HTTP status, or 0 when the network was cut. */
  status: number;
  /** For an answered query: `held_data`. */
  held?: string;
  /** For a write: `report` value. */
  report?: string;
  /** For a write: the per-grant error if any. */
  error?: string;
}

export interface WorldOptions {
  retention?: string | undefined;
  policy?: Partial<LifecyclePolicy>;
  legalRetention?: (q: { grantId: string; operationId: string }) => LegalRetentionSpec | null;
  /** Extra runtime options for the AS (restoreMechanism, recoveryTokenTtlMs...). */
  runtime?: Record<string, unknown>;
}

export class World {
  readonly calls: Call[] = [];
  /** Intervals of true time in which the AS cannot be reached. */
  outages: [number, number][] = [];
  inflight = 0;
  readonly storage = new MemoryClientCheckpointStorage();
  readonly app: ToyApp;
  client!: HeldDataClient;
  clientId = "";
  grantId = "";
  accessToken = "";
  refreshToken = "";
  /** A lifecycle recovery token, once the owner approved one. */
  recoveryToken: string | null = null;
  /** Usable-state transitions, to see exactly when use stopped. */
  readonly useLog: { at: number; ok: boolean; reason?: string }[] = [];
  readonly #opts: WorldOptions;
  readonly h: Harness;
  readonly clock: { now: number };

  private constructor(h: Harness, clock: { now: number }, opts: WorldOptions) {
    this.h = h;
    this.clock = clock;
    this.#opts = opts;
    this.app = new ToyApp(() => clock.now);
  }

  static async create(h: Harness, clock: { now: number }, opts: WorldOptions = {}): Promise<World> {
    const w = new World(h, clock, opts);
    w.clientId = await registerPublicClient(h);
    const g = await authCodeGrant(h, w.clientId, opts.retention ? { retention: { max_duration: opts.retention, on_expiry: "delete" } } : {});
    w.grantId = g.grantId;
    w.accessToken = g.accessToken;
    w.refreshToken = g.refreshToken;
    w.client = w.#build(true);
    return w;
  }

  /** Wraps fetch: cuts the network during outages, logs each lifecycle call. */
  readonly fetchImpl: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? new URLSearchParams(init.body) : new URLSearchParams();
    const kind: Call["kind"] = body.has("report") || body.has("pdpp_disposition") ? "write" : "query";
    const report = body.get("report") ?? undefined;
    const at = this.clock.now;
    if (this.down(at)) {
      this.calls.push({ at, kind, status: 0, ...(report ? { report } : {}) });
      throw new TypeError("fetch failed");
    }
    this.inflight += 1;
    try {
      const resp = await fetch(input, init);
      const call: Call = { at, kind, status: resp.status, ...(report ? { report } : {}) };
      if (resp.status === 200) {
        const j = (await resp.clone().json()) as { grants?: { held_data?: string; error?: string }[] };
        const e = j.grants?.[0];
        if (e?.held_data) call.held = e.held_data;
        if (e?.error) call.error = e.error;
      }
      this.calls.push(call);
      return resp;
    } finally {
      this.inflight -= 1;
    }
  };

  down(at = this.clock.now): boolean {
    return this.outages.some(([a, b]) => at >= a && at < b);
  }

  #build(initialize: boolean): HeldDataClient {
    const client = new HeldDataClient({
      now: () => this.clock.now,
      status: httpStatusTransport({
        asBaseUrl: this.h.asUrl,
        // Any token the AS issued for the grant works for a query; a recovery token too.
        credentialFor: () => this.recoveryToken ?? this.refreshToken,
        fetchImpl: this.fetchImpl,
      }),
      report: httpReportTransport({
        asBaseUrl: this.h.asUrl,
        // A public client's grant tokens stop authenticating writes when the grant ends; only recovery does.
        currentTokenFor: () => this.recoveryToken,
        fetchImpl: this.fetchImpl,
        now: () => this.clock.now,
      }),
      store: this.app,
      storage: this.storage,
      ...(initialize ? { initialize: true } : {}),
      ...(this.#opts.policy ? { policy: this.#opts.policy } : {}),
      ...(this.#opts.retention ? { retentionMaxDuration: this.#opts.retention } : {}),
      ...(this.#opts.legalRetention ? { legalRetention: this.#opts.legalRetention } : {}),
    });
    this.app.attach(client);
    return client;
  }

  /** The app process starts again: new client object, same durable checkpoint and same data. */
  restart(): HeldDataClient {
    this.client = this.#build(false);
    return this.client;
  }

  /** The grant was just issued: the token response is the first positive assessment, then the app syncs. */
  firstSync(extra: { id: string; stream: string; text: string }[] = []): void {
    this.client.onTokenResponse({ grantIds: [this.grantId], sentAt: this.clock.now });
    this.app.sync(this.grantId, [
      { id: "r1", stream: "top_artists", text: "hello world" },
      { id: "r2", stream: "top_artists", text: "alice bob" },
      ...extra,
    ]);
  }

  /** One use of the data through the gate; records transitions. */
  use(): boolean {
    const decision = this.client.canUse(this.grantId);
    const ok = this.app.search(this.grantId, "hello") !== null;
    const last = this.useLog[this.useLog.length - 1];
    const reason = decision.ok ? undefined : decision.reason;
    if (!last || last.ok !== ok || last.reason !== reason) {
      this.useLog.push({ at: this.clock.now, ok, ...(reason ? { reason } : {}) });
    }
    return ok;
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 4));
      while (this.inflight > 0) {
        await new Promise((r) => setTimeout(r, 4));
      }
    }
  }

  /** Advance true time to `until`, ticking the client and trying to use the data at each step. */
  async advance(until: number, step = HOUR): Promise<void> {
    while (this.clock.now < until) {
      this.clock.now = Math.min(until, this.clock.now + step);
      await this.client.tick();
      if (this.inflight > 0) await this.settle();
      this.use();
    }
  }

  queries(from = -Infinity, to = Infinity) {
    return this.calls.filter((c) => c.kind === "query" && c.at >= from && c.at < to);
  }

  writes() {
    return this.calls.filter((c) => c.kind === "write");
  }

  /** The owner's record for the grant (the AS owner interface). */
  async ownerRecord(): Promise<Record<string, any>> {
    const r = await owner(this.h, `/v1/owner/grants/${this.grantId}/lifecycle`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as Record<string, any>;
  }

  /** The owner chooses `delete` at the AS. */
  async ownerErase() {
    const r = await owner(this.h, `/v1/owner/grants/${this.grantId}/lifecycle/erase`, "POST");
    assert.ok(r.status === 200 || r.status === 202, JSON.stringify(r.body));
    return r.body as Record<string, any>;
  }

  /** The owner approves lifecycle recovery; the app keeps the token. */
  async recover(): Promise<string> {
    const r = await recoverLifecycle(this.h, this.clientId, [this.grantId]);
    this.recoveryToken = r.access_token;
    return r.access_token;
  }

  rsStatus(): Promise<number> {
    return rsRead(this.h, this.accessToken);
  }

  iso(ms: number): string {
    return new Date(ms).toISOString();
  }
}

/** Run a journey on a fresh AS with a shared injected clock starting at the real current time. */
export async function journey(
  opts: WorldOptions,
  fn: (w: World, h: Harness) => Promise<void>,
): Promise<void> {
  const clock = { now: Date.now() };
  await withServer(
    false,
    async (h) => {
      const w = await World.create(h, clock, opts);
      await fn(w, h);
    },
    heldDataOpts(clock, opts.runtime ?? {}),
  );
}

export { fetchJson };
