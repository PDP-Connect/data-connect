// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The reminder service's jobs:
//
//   runWeeklyReads    read each active child's record once per simulated
//                     week, evaluate the next due dose (log only), store the
//                     record and receipt, and pay once per served read.
//   runStatusChecks   lifecycle query for every grant with held data at
//                     least once per simulated day (hourly after a failure),
//                     and immediately after a read or refresh failure that
//                     shows the grant may have ended (PDPP PR #401).
//   runDeletionSweep  delete held data under an erasure instruction, within
//                     30 days of first receipt.
//   flushPayments     resend pending payment bodies unchanged.

import { createHash, type KeyObject, randomBytes, verify } from "node:crypto";
import { Agent } from "undici";
import { type Clock, DAY_MS, HOUR_MS, WEEK_MS } from "./clock.ts";
import { type ClientCredentials, type FetchLike, rotateRefreshToken } from "./oauth.ts";
import type { GatewayPayer } from "./payer.ts";
import { evaluateDueDose, type ImmunizationRecord } from "./schedule.ts";
import type { GrantStatusSource, LifecycleResult } from "./status.ts";
import type { ChildRow, ReminderStore } from "./store.ts";

export const READ_RECEIPT_HEADER = "pdpp-read-receipt";
export const STOP_USE_BOUND_MS = 48 * HOUR_MS;
export const DELETION_BOUND_MS = 30 * DAY_MS;

export interface ServiceConfig {
  concurrency: number;
  /** Delay between learning of an erasure instruction and deleting (0 = next sweep). Must stay under 30 days. */
  deleteGraceMs: number;
  /** Max reads per second across lanes; null = unpaced. */
  ratePerSecond: number | null;
  readIntervalMs: number;
  /** Register public key used to verify read receipts; null = do not verify. */
  receiptPublicKey: KeyObject | null;
  /** Refresh when the access token expires within this margin (real time). */
  refreshMarginMs: number;
  retryIntervalMs: number;
  rsUrl: string;
  statusIntervalMs: number;
  stream: string;
  tokenEndpoint: string;
}

export const DEFAULT_CONFIG: Omit<ServiceConfig, "rsUrl" | "tokenEndpoint"> = {
  concurrency: 64,
  deleteGraceMs: 0,
  ratePerSecond: null,
  readIntervalMs: WEEK_MS,
  receiptPublicKey: null,
  refreshMarginMs: 60_000,
  retryIntervalMs: HOUR_MS,
  statusIntervalMs: DAY_MS,
  stream: "child_immunizations",
};

type CounterTree = { [key: string]: number | CounterTree };

export class Counters {
  readonly data: CounterTree = {};
  inc(path: string, by = 1): void {
    const parts = path.split(".");
    let node = this.data;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as CounterTree;
    }
    const leaf = parts.at(-1) as string;
    node[leaf] = ((node[leaf] as number | undefined) ?? 0) + by;
  }
  get(path: string): number {
    let node: number | CounterTree | undefined = this.data;
    for (const part of path.split(".")) {
      node = typeof node === "object" ? node[part] : undefined;
    }
    return typeof node === "number" ? node : 0;
  }
  merge(other: CounterTree, prefix = ""): void {
    for (const [k, v] of Object.entries(other)) {
      if (typeof v === "number") {
        this.inc(`${prefix}${k}`, v);
      } else {
        this.merge(v, `${prefix}${k}.`);
      }
    }
  }
}

class RateLimiter {
  private next = 0;
  private readonly perSecond: number | null;
  constructor(perSecond: number | null) {
    this.perSecond = perSecond;
  }
  async take(): Promise<void> {
    if (!this.perSecond) {
      return;
    }
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + 1000 / this.perSecond;
    if (slot > now) {
      await new Promise((resolve) => setTimeout(resolve, slot - now));
    }
  }
}

interface ParsedReceipt {
  grantId: string | null;
  readId: string;
  recordSha256: string;
  servedAt: string | null;
  value: string;
  verified: boolean;
}

export function parseAndVerifyReceipt(value: string, publicKey: KeyObject | null): ParsedReceipt | null {
  const parts = value.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string };
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    let verified = false;
    if (publicKey) {
      const data = Buffer.from(`${h}.${p}`, "ascii");
      const sig = Buffer.from(s, "base64url");
      verified =
        header.alg === "EdDSA"
          ? verify(null, data, publicKey, sig)
          : verify("sha256", data, { dsaEncoding: "ieee-p1363", key: publicKey }, sig);
    }
    return {
      grantId: typeof payload.grant_id === "string" ? payload.grant_id : null,
      readId: String(payload.read_id),
      recordSha256: String(payload.record_sha256),
      servedAt: typeof payload.served_at === "string" ? payload.served_at : null,
      value,
      verified,
    };
  } catch {
    return null;
  }
}

export interface ServiceDeps {
  client: ClientCredentials;
  clock: Clock;
  config: ServiceConfig;
  /** Read path fetch; defaults to undici with `concurrency` keep-alive connections. */
  fetchImpl?: FetchLike;
  log?: (line: Record<string, unknown>) => void;
  payer: GatewayPayer;
  status: GrantStatusSource;
  store: ReminderStore;
  /** Token endpoint fetch (kept separate so tests can break it). */
  tokenFetchImpl?: FetchLike;
}

export class ReminderService {
  readonly counters = new Counters();
  private readonly deps: ServiceDeps;
  private readonly fetchImpl: FetchLike;
  private readonly limiter: RateLimiter;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    const agent = new Agent({ connections: deps.config.concurrency, keepAliveTimeout: 30_000 });
    this.fetchImpl =
      deps.fetchImpl ?? ((url, init) => fetch(url, { ...init, dispatcher: agent } as RequestInit));
    this.limiter = new RateLimiter(deps.config.ratePerSecond);
    const lost = deps.store.markInFlightRefreshesLost();
    if (lost) {
      this.counters.inc("refresh.lost_on_restart", lost);
    }
  }

  private now(): number {
    return this.deps.clock.now();
  }

  private log(line: Record<string, unknown>): void {
    this.deps.log?.({ at: new Date(this.now()).toISOString(), ...line });
  }

  private async lanes<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const n = Math.max(1, Math.min(this.deps.config.concurrency, items.length));
    await Promise.all(
      Array.from({ length: n }, async () => {
        while (i < items.length) {
          const item = items[i] as T;
          i += 1;
          await worker(item);
        }
      })
    );
  }

  // ─── weekly reads ──────────────────────────────────────────────────────────

  async runWeeklyReads(pageSize = 5000): Promise<void> {
    const dueBefore = this.now() - this.deps.config.readIntervalMs;
    let after = 0;
    for (;;) {
      const page = this.deps.store.listReadable(dueBefore, pageSize, after);
      if (!page.length) {
        break;
      }
      after = (page.at(-1) as ChildRow).child_index;
      await this.lanes(page, (row) => this.readOne(row));
    }
    await this.useHeldRecordsOfEndedGrants();
    await this.runStatusChecks({ onlyForced: true });
    await this.flushPayments();
  }

  private async ensureAccessToken(row: ChildRow): Promise<string | null> {
    const fresh =
      row.access_token &&
      (row.access_expires_at === null || row.access_expires_at > Date.now() + this.deps.config.refreshMarginMs);
    if (fresh) {
      return row.access_token;
    }
    if (row.refresh_state !== "idle") {
      // Bulk-imported grants have no refresh token: use the access token as is.
      return row.refresh_state === "none" ? row.access_token : null;
    }
    const outcome = await rotateRefreshToken({
      childIndex: row.child_index,
      client: this.deps.client,
      store: this.deps.store,
      tokenEndpoint: this.deps.config.tokenEndpoint,
      ...(this.deps.tokenFetchImpl ? { fetchImpl: this.deps.tokenFetchImpl } : {}),
    });
    this.counters.inc(`refresh.${outcome.kind}`);
    if (outcome.kind === "refreshed") {
      return outcome.accessToken;
    }
    this.log({ child: row.child_id, error: outcome.error, event: `refresh_${outcome.kind}` });
    return null;
  }

  private async readOne(row: ChildRow): Promise<void> {
    const token = await this.ensureAccessToken(row);
    if (!token) {
      this.counters.inc("reads.skipped_no_token");
      return;
    }
    await this.limiter.take();
    this.counters.inc("reads.attempted");
    const url = `${this.deps.config.rsUrl}/v1/streams/${encodeURIComponent(this.deps.config.stream)}/records/${encodeURIComponent(row.child_id)}`;
    let resp: Response;
    let text: string;
    try {
      resp = await this.fetchImpl(url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        method: "GET",
        signal: AbortSignal.timeout(15_000),
      });
      text = await resp.text();
    } catch (err) {
      this.counters.inc("reads.errored.transport");
      this.log({ child: row.child_id, error: String((err as Error).message ?? err), event: "read_error" });
      return;
    }
    if (resp.status !== 200) {
      let code = "unknown";
      try {
        const body = JSON.parse(text) as { error?: { code?: string } | string };
        code = typeof body.error === "string" ? body.error : (body.error?.code ?? "unknown");
      } catch {
        // non-JSON error body
      }
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
        this.counters.inc(`reads.denied.${resp.status}_${code}`);
      } else {
        this.counters.inc(`reads.errored.${resp.status}_${code}`);
      }
      if (resp.status === 401 || resp.status === 403) {
        // The grant may have ended: query its lifecycle before further use.
        this.deps.store.update(row.child_index, { status_check_due: 1 });
      }
      return;
    }
    await this.onServed(row, text, resp.headers.get(READ_RECEIPT_HEADER));
  }

  private async onServed(row: ChildRow, text: string, receiptHeader: string | null): Promise<void> {
    const now = this.now();
    const recordSha256 = createHash("sha256").update(text, "utf8").digest("hex");
    let receipt = receiptHeader ? parseAndVerifyReceipt(receiptHeader, this.deps.config.receiptPublicKey) : null;
    if (!receipt) {
      this.counters.inc("receipts.missing");
    } else if (receipt.recordSha256 !== recordSha256 || (receipt.grantId && receipt.grantId !== row.grant_id)) {
      this.counters.inc("receipts.mismatch");
      receipt = { ...receipt, verified: false };
    } else if (this.deps.config.receiptPublicKey) {
      this.counters.inc(receipt.verified ? "receipts.verified" : "receipts.invalid_signature");
    } else {
      this.counters.inc("receipts.unverified_no_key");
    }
    const readId = receipt?.readId ?? `0x${randomBytes(32).toString("hex")}`;
    let record: ImmunizationRecord;
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      record = ((body.data as ImmunizationRecord | undefined) ?? body) as unknown as ImmunizationRecord;
    } catch {
      this.counters.inc("reads.errored.unparsable_body");
      return;
    }
    this.counters.inc("reads.succeeded");
    const due = evaluateDueDose(record, now);
    if (due) {
      this.counters.inc(`due_doses.${due.status}`);
      this.log({ child: row.child_id, due, event: "due_dose_flagged" });
    }
    const payment = await this.deps.payer.prepare({
      childId: row.child_id,
      childIndex: row.child_index,
      grantId: row.grant_id,
      readId,
      recordSha256,
      servedAt: receipt?.servedAt ?? null,
    });
    this.deps.store.recordServedRead({
      childIndex: row.child_index,
      dueJson: due ? JSON.stringify(due) : null,
      payment,
      readAt: now,
      readId,
      receipt: {
        grantId: row.grant_id,
        recordSha256,
        servedAt: receipt?.servedAt ?? null,
        value: receipt?.value ?? null,
        verified: receipt?.verified ?? false,
      },
      recordJson: text,
    });
    this.counters.inc("records.received");
    await this.sendPayment(readId, payment.bodyJson);
  }

  /** Grants that ended with "keep": held records stay usable for the approved purpose. */
  private async useHeldRecordsOfEndedGrants(): Promise<void> {
    const rows = this.deps.store.db
      .prepare("SELECT child_index, child_id, last_record_json FROM children WHERE status = 'ended_keep' AND last_record_json IS NOT NULL")
      .iterate() as Iterable<{ child_id: string; child_index: number; last_record_json: string }>;
    for (const row of rows) {
      const body = JSON.parse(row.last_record_json) as Record<string, unknown>;
      const due = evaluateDueDose(((body.data ?? body) as unknown) as ImmunizationRecord, this.now());
      if (due) {
        this.counters.inc(`due_doses_from_held.${due.status}`);
      }
    }
  }

  // ─── payments ──────────────────────────────────────────────────────────────

  private async sendPayment(readId: string, bodyJson: string): Promise<void> {
    this.counters.inc("payments.sent");
    const result = await this.deps.payer.send(bodyJson);
    if (result.accepted) {
      this.deps.store.settlePayment(readId, "accepted", JSON.stringify(result.response));
      this.counters.inc("payments.accepted");
    } else if (result.retryable) {
      this.counters.inc("payments.retry_pending");
    } else {
      this.deps.store.settlePayment(readId, "rejected", JSON.stringify(result.response));
      this.counters.inc("payments.rejected");
      this.log({ event: "payment_rejected", readId, response: result.response });
    }
  }

  async flushPayments(): Promise<void> {
    for (;;) {
      const pending = this.deps.store.pendingPayments(1000);
      if (!pending.length) {
        return;
      }
      let progressed = false;
      for (const p of pending) {
        const before = this.counters.get("payments.retry_pending");
        await this.sendPayment(p.read_id, p.body_json);
        progressed ||= this.counters.get("payments.retry_pending") === before;
      }
      if (!progressed) {
        return;
      }
    }
  }

  // ─── lifecycle / status ────────────────────────────────────────────────────

  async runStatusChecks(opts: { onlyForced?: boolean } = {}): Promise<void> {
    const now = this.now();
    const dueBefore = now - this.deps.config.statusIntervalMs;
    const source = this.deps.status;
    let after = 0;
    for (;;) {
      const page = this.deps.store.listStatusDue(dueBefore, 5000, after, opts.onlyForced === true);
      if (!page.length) {
        break;
      }
      after = (page.at(-1) as ChildRow).child_index;
      const batches: ChildRow[][] = [];
      for (let i = 0; i < page.length; i += source.batchSize) {
        batches.push(page.slice(i, i + source.batchSize));
      }
      await this.lanes(batches, async (batch) => {
        this.counters.inc("status.attempted", batch.length);
        let results: LifecycleResult[];
        try {
          results = await source.query(
            batch.map((r) => ({ accessToken: r.access_token, grantId: r.grant_id, refreshToken: r.refresh_token }))
          );
        } catch (err) {
          this.counters.inc("status.failed_transport", batch.length);
          for (const r of batch) {
            this.markStatusFailure(r, now);
          }
          this.log({ error: String((err as Error).message ?? err), event: "status_query_failed" });
          return;
        }
        results.forEach((result, i) => {
          const row = batch[i] as ChildRow;
          if (result.kind === "error") {
            this.counters.inc("status.failed_grant");
            this.markStatusFailure(row, now);
            return;
          }
          this.counters.inc("status.succeeded");
          this.applyAnswer(row, result.answer, now);
        });
      });
    }
    await this.reportReceipts();
  }

  /** A failed attempt is retried within the retry interval (1 h), not the daily one. */
  private markStatusFailure(row: ChildRow, now: number): void {
    this.deps.store.update(row.child_index, {
      last_status_attempt_at: now - this.deps.config.statusIntervalMs + this.deps.config.retryIntervalMs,
    });
  }

  private applyAnswer(
    row: ChildRow,
    answer: Extract<LifecycleResult, { kind: "answer" }>["answer"],
    now: number
  ): void {
    const base = {
      ended_at: answer.endedAt,
      last_status_attempt_at: now,
      last_status_ok_at: now,
      read_state: answer.readState,
      status_check_due: 0,
    };
    if (answer.heldData === "erase" && answer.erasure) {
      if (row.status === "erase_pending" || row.status === "deleted") {
        this.deps.store.update(row.child_index, base);
        return;
      }
      const stopUseBy = Date.parse(answer.erasure.stopUseBy);
      this.counters.inc("erasure.instructions_received");
      this.counters.inc(now <= stopUseBy ? "erasure.stopped_within_48h" : "erasure.stopped_late_learned_after_bound");
      this.deps.store.update(row.child_index, {
        ...base,
        delete_by: now + DELETION_BOUND_MS,
        disposition: "delete",
        erasure_effective_at: Date.parse(answer.erasure.effectiveAt),
        erasure_instruction_id: answer.erasure.instructionId,
        erasure_receipt_at: now,
        status: "erase_pending",
        stop_use_by: stopUseBy,
        stopped_at: now,
      });
      this.deps.store.event(now, row.child_index, "erasure_received", answer.erasure);
      this.log({ child: row.child_id, event: "erasure_received", instruction: answer.erasure.instructionId });
      return;
    }
    if (answer.readState === "active") {
      this.deps.store.update(row.child_index, base);
      return;
    }
    if (row.status === "active" || row.status === "needs_reauth") {
      this.counters.inc("lifecycle.ended_keep");
      this.deps.store.event(now, row.child_index, "grant_ended_keep", { ended_at: answer.endedAt, read_state: answer.readState });
    }
    this.deps.store.update(row.child_index, {
      ...base,
      disposition: row.disposition ?? "keep",
      status: row.status === "erase_pending" || row.status === "deleted" ? row.status : "ended_keep",
    });
  }

  private async reportReceipts(): Promise<void> {
    const source = this.deps.status;
    if (!source.report) {
      return;
    }
    const report = source.report.bind(source);
    const rows = this.deps.store.db
      .prepare(
        "SELECT * FROM children WHERE erasure_instruction_id IS NOT NULL AND child_index NOT IN (SELECT child_index FROM events WHERE kind = 'erasure_receipt_reported')"
      )
      .all() as ChildRow[];
    for (const row of rows) {
      const ok = await report({
        grantId: row.grant_id,
        instructionId: row.erasure_instruction_id as string,
        report: "received",
        reportedAt: new Date(row.erasure_receipt_at as number).toISOString(),
      }).catch(() => false);
      if (ok) {
        this.deps.store.event(this.now(), row.child_index, "erasure_receipt_reported");
      }
    }
  }

  // ─── deletion ──────────────────────────────────────────────────────────────

  async runDeletionSweep(): Promise<void> {
    const now = this.now();
    for (const row of this.deps.store.listEraseDue()) {
      const receivedAt = row.erasure_receipt_at ?? now;
      if (now < receivedAt + this.deps.config.deleteGraceMs && now < (row.delete_by ?? Number.POSITIVE_INFINITY)) {
        continue;
      }
      const overdue = row.delete_by !== null && now > row.delete_by;
      const tx = this.deps.store.db.transaction(() => {
        this.deps.store.update(row.child_index, {
          deleted_at: now,
          last_due_json: null,
          last_record_json: null,
          last_record_sha256: null,
          status: "deleted",
        });
        // Derived data: due-dose flags. Receipts and payments stay as
        // accounting records (hash + ids only, no record content).
        this.deps.store.db.prepare("DELETE FROM events WHERE child_index = ? AND kind = 'due_dose'").run(row.child_index);
        this.deps.store.event(now, row.child_index, overdue ? "deletion_completed_late" : "deletion_completed");
      });
      tx();
      this.counters.inc(overdue ? "erasure.deletions_overdue" : "erasure.deletions_completed");
      if (this.deps.status.report && row.erasure_instruction_id) {
        await this.deps.status
          .report({
            grantId: row.grant_id,
            instructionId: row.erasure_instruction_id,
            report: "completed",
            reportedAt: new Date(now).toISOString(),
          })
          .catch(() => false);
      }
    }
  }

  /** Counters for this process plus store totals, for the four-way reconciliation. */
  snapshot(): Record<string, unknown> {
    return {
      at: new Date(this.now()).toISOString(),
      counters: this.counters.data,
      payer: this.deps.payer.name,
      status_source: this.deps.status.name,
      store: this.deps.store.totals(),
    };
  }
}
