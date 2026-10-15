// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The reminder service's own store (SQLite, WAL). One row per child grant:
// tokens, refresh-rotation state, lifecycle state, the last record held, and
// counts. Payment intents are persisted before they are sent so each served
// read is paid exactly once, including across restarts.

import Database from "better-sqlite3";

export type ChildStatus =
  /** Grant active; read weekly. */
  | "active"
  /** Grant ended with no erasure instruction: no reads, held data may be kept and used for the approved purpose. */
  | "ended_keep"
  /** Refresh family unusable (invalid_grant or an ambiguous refresh); no reads until re-authorized. */
  | "needs_reauth"
  /** Erasure instruction received: use stopped, deletion pending. */
  | "erase_pending"
  /** Held data deleted. */
  | "deleted";

/**
 * Refresh-rotation state. `in_flight` is written (and committed) before the
 * refresh request; a crash or an ambiguous outcome leaves `lost`, which is
 * never retried automatically: replaying a superseded refresh token revokes
 * the whole family (PDPP Core Section 10, RFC 9700 4.14.2).
 */
export type RefreshState = "idle" | "in_flight" | "lost" | "dead" | "none";

export interface ChildRow {
  access_expires_at: number | null;
  access_token: string | null;
  child_id: string;
  child_index: number;
  delete_by: number | null;
  deleted_at: number | null;
  disposition: string | null;
  ended_at: string | null;
  erasure_effective_at: number | null;
  erasure_instruction_id: string | null;
  erasure_receipt_at: number | null;
  grant_id: string;
  last_due_json: string | null;
  last_read_at: number | null;
  last_record_json: string | null;
  last_record_sha256: string | null;
  last_status_attempt_at: number | null;
  last_status_ok_at: number | null;
  read_state: string | null;
  received_count: number;
  refresh_state: RefreshState;
  refresh_token: string | null;
  status: ChildStatus;
  status_check_due: number;
  stop_use_by: number | null;
  stopped_at: number | null;
}

export interface PaymentRow {
  amount: string;
  body_json: string;
  child_index: number;
  created_at: number;
  read_id: string;
  response_json: string | null;
  status: "pending" | "accepted" | "rejected";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS children (
  child_index INTEGER PRIMARY KEY,
  child_id TEXT NOT NULL,
  grant_id TEXT NOT NULL UNIQUE,
  access_token TEXT,
  access_expires_at INTEGER,
  refresh_token TEXT,
  refresh_state TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'active',
  read_state TEXT,
  ended_at TEXT,
  disposition TEXT,
  erasure_instruction_id TEXT,
  erasure_effective_at INTEGER,
  erasure_receipt_at INTEGER,
  stop_use_by INTEGER,
  stopped_at INTEGER,
  delete_by INTEGER,
  deleted_at INTEGER,
  last_record_json TEXT,
  last_record_sha256 TEXT,
  last_read_at INTEGER,
  last_due_json TEXT,
  last_status_attempt_at INTEGER,
  last_status_ok_at INTEGER,
  status_check_due INTEGER NOT NULL DEFAULT 0,
  received_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS children_status ON children(status);
CREATE TABLE IF NOT EXISTS payments (
  read_id TEXT PRIMARY KEY,
  child_index INTEGER NOT NULL,
  amount TEXT NOT NULL,
  body_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  response_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  read_id TEXT PRIMARY KEY,
  child_index INTEGER NOT NULL,
  grant_id TEXT NOT NULL,
  record_sha256 TEXT NOT NULL,
  receipt TEXT,
  verified INTEGER NOT NULL,
  served_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  child_index INTEGER,
  kind TEXT NOT NULL,
  detail TEXT
);
`;

export class ReminderStore {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  upsertChild(row: {
    access_expires_at?: number | null;
    access_token: string | null;
    child_id: string;
    child_index: number;
    grant_id: string;
    refresh_token?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO children (child_index, child_id, grant_id, access_token, access_expires_at, refresh_token, refresh_state)
         VALUES (@child_index, @child_id, @grant_id, @access_token, @access_expires_at, @refresh_token, @refresh_state)
         ON CONFLICT(child_index) DO UPDATE SET grant_id = excluded.grant_id, access_token = excluded.access_token,
           access_expires_at = excluded.access_expires_at, refresh_token = excluded.refresh_token,
           refresh_state = excluded.refresh_state, status = 'active'`
      )
      .run({
        access_expires_at: row.access_expires_at ?? null,
        access_token: row.access_token,
        child_id: row.child_id,
        child_index: row.child_index,
        grant_id: row.grant_id,
        refresh_state: row.refresh_token ? "idle" : "none",
        refresh_token: row.refresh_token ?? null,
      });
  }

  getChild(childIndex: number): ChildRow | undefined {
    return this.db.prepare("SELECT * FROM children WHERE child_index = ?").get(childIndex) as ChildRow | undefined;
  }

  getChildByGrant(grantId: string): ChildRow | undefined {
    return this.db.prepare("SELECT * FROM children WHERE grant_id = ?").get(grantId) as ChildRow | undefined;
  }

  /** Children due for a weekly read: active and not read since `before`. */
  listReadable(before: number, limit: number, afterIndex = 0): ChildRow[] {
    return this.db
      .prepare(
        `SELECT * FROM children WHERE status = 'active' AND child_index > ? AND (last_read_at IS NULL OR last_read_at <= ?)
         ORDER BY child_index LIMIT ?`
      )
      .all(afterIndex, before, limit) as ChildRow[];
  }

  /**
   * Children owing a lifecycle query: held data present (not deleted) and no
   * attempt since `before`, or a query forced by a failed read/refresh.
   */
  listStatusDue(before: number, limit: number, afterIndex = 0, forcedOnly = false): ChildRow[] {
    if (forcedOnly) {
      return this.db
        .prepare(
          "SELECT * FROM children WHERE status != 'deleted' AND child_index > ? AND status_check_due = 1 ORDER BY child_index LIMIT ?"
        )
        .all(afterIndex, limit) as ChildRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM children WHERE status != 'deleted' AND child_index > ?
           AND (status_check_due = 1 OR last_status_attempt_at IS NULL OR last_status_attempt_at <= ?)
         ORDER BY child_index LIMIT ?`
      )
      .all(afterIndex, before, limit) as ChildRow[];
  }

  listEraseDue(): ChildRow[] {
    return this.db.prepare("SELECT * FROM children WHERE status = 'erase_pending' ORDER BY child_index").all() as ChildRow[];
  }

  update(childIndex: number, fields: Partial<ChildRow>): void {
    const keys = Object.keys(fields);
    if (!keys.length) {
      return;
    }
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE children SET ${sets} WHERE child_index = @child_index`).run({ ...fields, child_index: childIndex });
  }

  /**
   * Marks a refresh as in flight, but only from `idle`. Returns false when
   * another state is recorded (lost/dead/in_flight): the caller must not send.
   */
  beginRefresh(childIndex: number, presentedToken: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE children SET refresh_state = 'in_flight' WHERE child_index = ? AND refresh_state = 'idle' AND refresh_token = ?"
      )
      .run(childIndex, presentedToken);
    return result.changes === 1;
  }

  /** On startup, any refresh left in flight by a crash is ambiguous. */
  markInFlightRefreshesLost(): number {
    return this.db
      .prepare("UPDATE children SET refresh_state = 'lost', status = CASE WHEN status = 'active' THEN 'needs_reauth' ELSE status END WHERE refresh_state = 'in_flight'")
      .run().changes;
  }

  /** Stores a served record, its receipt and the payment intent in one transaction. */
  recordServedRead(input: {
    childIndex: number;
    dueJson: string | null;
    payment: { amount: string; bodyJson: string } | null;
    readAt: number;
    readId: string;
    receipt: { grantId: string; recordSha256: string; servedAt: string | null; value: string | null; verified: boolean };
    recordJson: string;
  }): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE children SET last_record_json = ?, last_record_sha256 = ?, last_read_at = ?, last_due_json = ?,
             received_count = received_count + 1 WHERE child_index = ?`
        )
        .run(input.recordJson, input.receipt.recordSha256, input.readAt, input.dueJson, input.childIndex);
      this.db
        .prepare(
          "INSERT INTO receipts (read_id, child_index, grant_id, record_sha256, receipt, verified, served_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          input.readId,
          input.childIndex,
          input.receipt.grantId,
          input.receipt.recordSha256,
          input.receipt.value,
          input.receipt.verified ? 1 : 0,
          input.receipt.servedAt
        );
      if (input.payment) {
        this.db
          .prepare("INSERT INTO payments (read_id, child_index, amount, body_json, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(input.readId, input.childIndex, input.payment.amount, input.payment.bodyJson, input.readAt);
      }
    });
    tx();
  }

  pendingPayments(limit = 1000): PaymentRow[] {
    return this.db
      .prepare("SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at LIMIT ?")
      .all(limit) as PaymentRow[];
  }

  settlePayment(readId: string, status: "accepted" | "rejected", responseJson: string): void {
    this.db
      .prepare("UPDATE payments SET status = ?, response_json = ? WHERE read_id = ? AND status = 'pending'")
      .run(status, responseJson, readId);
  }

  /** Allocates the next per-payer payment nonce (persisted before signing). */
  nextPaymentNonce(): bigint {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'payment_nonce'").get() as
        | { value: string }
        | undefined;
      const next = BigInt(row?.value ?? "0") + 1n;
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('payment_nonce', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(next.toString());
      return next;
    });
    return tx();
  }

  event(at: number, childIndex: number | null, kind: string, detail: unknown = null): void {
    this.db
      .prepare("INSERT INTO events (at, child_index, kind, detail) VALUES (?, ?, ?, ?)")
      .run(at, childIndex, kind, detail === null ? null : JSON.stringify(detail));
  }

  /** Store-side reconciliation figures (records received, payments by status, receipts). */
  totals(): Record<string, number> {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number | null }).n ?? 0);
    return {
      children: one("SELECT COUNT(*) AS n FROM children"),
      children_active: one("SELECT COUNT(*) AS n FROM children WHERE status = 'active'"),
      children_deleted: one("SELECT COUNT(*) AS n FROM children WHERE status = 'deleted'"),
      children_ended_keep: one("SELECT COUNT(*) AS n FROM children WHERE status = 'ended_keep'"),
      children_erase_pending: one("SELECT COUNT(*) AS n FROM children WHERE status = 'erase_pending'"),
      children_needs_reauth: one("SELECT COUNT(*) AS n FROM children WHERE status = 'needs_reauth'"),
      payments_accepted: one("SELECT COUNT(*) AS n FROM payments WHERE status = 'accepted'"),
      payments_pending: one("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'"),
      payments_rejected: one("SELECT COUNT(*) AS n FROM payments WHERE status = 'rejected'"),
      receipts_stored: one("SELECT COUNT(*) AS n FROM receipts"),
      receipts_verified: one("SELECT COUNT(*) AS n FROM receipts WHERE verified = 1"),
      records_received: one("SELECT SUM(received_count) AS n FROM children"),
    };
  }
}
