// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs the settlement poller (settlement.ts) inside a long-lived process, for
// the walkthrough server with VACUNA_PAYER=moksha. One poll at a time: a
// timer tick or a dashboard view while a poll is running joins that poll.
// Errors are logged and kept in `lastError`; they never throw to callers.
//
// Block range: the first run records a start block in the Moksha state
// (poll.startBlock / poll.fromBlock, saved in the state dir) and every poll
// then scans only from the saved cursor. The start block is
// VACUNA_MOKSHA_FROM_BLOCK if set; else, when the state already holds paid
// reads that are not settled, latest - lookback (they may have settled
// before this process first ran); else latest - a small margin.

import { pollSettlements, type PollDeps } from "./settlement.ts";

export interface SettlementWatcherOptions {
  /** Margin below the latest block on a fresh state with nothing to find. */
  bootMargin?: bigint;
  deps: PollDeps;
  env?: NodeJS.ProcessEnv;
  /** Timer period; 0 disables the timer (polls run only on demand). */
  intervalMs?: number;
  /** Start block distance when unsettled paid reads predate the first run. */
  lookback?: bigint;
  now?: () => number;
  /** A dashboard view triggers a poll when the last attempt is at least this old. */
  staleMs?: number;
}

export class SettlementWatcher {
  lastAttemptAt: number | null = null;
  lastError: string | null = null;
  lastSuccessAt: number | null = null;
  /** Polls started (joined callers do not count). */
  runs = 0;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: Required<Omit<SettlementWatcherOptions, "deps" | "env">> & Pick<SettlementWatcherOptions, "deps" | "env">;

  constructor(opts: SettlementWatcherOptions) {
    this.opts = {
      bootMargin: 100n,
      intervalMs: 60_000,
      lookback: 20_000n,
      now: () => Date.now(),
      staleMs: 30_000,
      ...opts,
    };
  }

  /** First poll now, then every intervalMs. The timer does not keep the process alive. */
  start(): void {
    if (this.opts.intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.poll(), this.opts.intervalMs);
      this.timer.unref();
    }
    void this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one poll, or joins the one already running. Never rejects. */
  poll(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.run().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /**
   * For a dashboard view: starts a poll if the last attempt is stale (or joins
   * a running one) and waits for it at most `waitMs`, so a slow RPC never
   * holds the page.
   */
  async refreshIfStale(waitMs = 3_000): Promise<void> {
    const stale = this.lastAttemptAt === null || this.opts.now() - this.lastAttemptAt >= this.opts.staleMs;
    const running = this.inflight ?? (stale ? this.poll() : null);
    if (!running) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([running, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
  }

  private async run(): Promise<void> {
    const { deps } = this.opts;
    const log = deps.log ?? (() => {});
    this.runs += 1;
    this.lastAttemptAt = this.opts.now();
    try {
      await this.ensureStartBlock();
      await pollSettlements(deps);
      this.lastError = null;
      this.lastSuccessAt = this.opts.now();
    } catch (err) {
      this.lastError = (err as Error).message ?? String(err);
      log({ error: this.lastError, event: "settlement_poll_failed" });
    }
  }

  private async ensureStartBlock(): Promise<void> {
    const { deps, env } = this.opts;
    const poll = deps.state.data.poll;
    if (poll.fromBlock !== null) {
      return;
    }
    const latest = BigInt(await deps.rpc.call<string>("eth_blockNumber"));
    const below = (n: bigint) => (latest > n ? latest - n : 0n);
    const fromEnv = (env ?? process.env).VACUNA_MOKSHA_FROM_BLOCK;
    const open = Object.values(deps.state.data.payments).some((p) => p.status === "prepared" || p.status === "accepted");
    const start = fromEnv ? BigInt(fromEnv) : open ? below(this.opts.lookback) : below(this.opts.bootMargin);
    poll.startBlock = start.toString();
    poll.fromBlock = start.toString();
    deps.state.save();
    deps.log?.({ event: "settlement_poll_start_block", latestBlock: latest.toString(), startBlock: poll.startBlock });
  }
}
