/**
 * Per-grant training authority (lease note L3, L4, L9) for the AI-training
 * lease prototype.
 *
 * Deliberately NOT part of the main reference database or its backup
 * inventory (server/backup-table-policy.ts). L3 requires that a backup restore
 * cannot roll back a withdrawal, and every main-database table is restored
 * together.
 *
 * Design (as built, after the first version failed its restore tests):
 *
 * - The authority is an append-only journal that MUST sit outside every
 *   restore path. Every authority creation, every issued lease (its `exp`),
 *   and every withdrawal (tombstone) is appended and fsynced before it takes
 *   effect. O_APPEND gives the entries one total order.
 * - The SQLite file is a projection of the journal, rebuilt by replay on
 *   every open. Restoring it from a backup loses nothing: the next open
 *   replays what the backup missed.
 * - Issuance: check the row, append `issue`, commit; then re-read the
 *   journal. If a tombstone for the grant precedes the `issue` entry, the
 *   lease is not returned. Only then is the lease signed and returned.
 * - Withdrawal: append `tombstone`, then compute T from the journal as the
 *   maximum `exp` of every `issue` entry before the tombstone (or the
 *   withdrawal time). Any `issue` after the tombstone is never returned, so T
 *   bounds every lease the AS ever returned, whichever node or store copy
 *   issued it.
 *
 * Under this design the note's per-grant fencing epoch and stale-node fencing
 * are unnecessary: a node writing to a stale store copy still appends to the
 * one journal, and the post-append check refuses it.
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type BetterSqlite3 from "better-sqlite3";
import { SqliteDriver } from "../../server/sqlite-driver.ts";
import { appendJournalEntry, JournalReader } from "../authority-journal/journal.ts";
import {
  AI_TRAINING_PERMISSION,
  LEASE_JWS_TYP,
  MAX_LEASE_LIFETIME_MS,
} from "./constants.ts";
import {
  exportPrivateKeyPem,
  generateEd25519KeyPair,
  importPrivateKeyPem,
  type OkpPublicJwk,
  signCompactJws,
} from "./jws.ts";

// The repo's single SQLite driver: every connection in a process must come
// from the same package, or same-file locks do not contend.
const Database = SqliteDriver as unknown as typeof BetterSqlite3;
type SqliteDatabase = BetterSqlite3.Database;

export type AuthorityEndReason =
  | "training_withdrawn"
  | "grant_revoked"
  | "credential_theft"
  | string;

export interface AuthorityStoreOptions {
  storePath: string;
  /** Append-only journal. MUST be outside every backup-restore path. */
  journalPath: string;
  issuer: string;
  nodeId: string;
  now: () => number;
  leaseLifetimeMs?: number;
  /** SQLite busy timeout. A node that cannot get the record in time does not issue. */
  busyTimeoutMs?: number;
  /** Test hook: runs after the `issue` entry is journaled and committed, before the post-append check. */
  afterIssueJournaledForTest?: () => void;
  /** Test hook: runs after a tombstone is journaled, before the store commits. */
  afterTombstoneJournaledForTest?: () => void;
}

export interface AuthorityRow {
  grant_id: string;
  client_id: string;
  subject_id: string;
  permission: string;
  training_expires_at_ms: number;
  state: "active" | "withdrawn";
  end_reason: string | null;
  max_exp_ms: number | null;
  withdrawn_at_ms: number | null;
  stop_by_ms: number | null;
  created_at_ms: number;
}

export interface LeaseClaimsOut {
  iss: string;
  aud: string;
  jti: string;
  grant_id: string;
  permission: string;
  iat: number;
  exp: number;
  /** B3: acquisition grants whose copies the lease covers. Absent: the training grant's own copy. */
  acq?: string[];
}

export type IssueRefusal =
  | "unknown_grant"
  | "wrong_client"
  | "withdrawn"
  | "expired"
  | "acquisition_erased"
  | "unavailable";

export type IssueOutcome =
  | { ok: true; lease: string; claims: LeaseClaimsOut; kid: string }
  /** Internal reason. The HTTP layer must collapse every value to one "no lease" answer. */
  | { ok: false; reason: IssueRefusal };

export type WithdrawOutcome =
  | { state: "withdrawn"; stopsByMs: number; alreadyWithdrawn: boolean }
  | { state: "unknown_grant" };

export type AuthorityStatus =
  | { state: "active"; maxExpMs: number | null; trainingExpiresAtMs: number }
  | { state: "withdrawn"; stopsByMs: number; endReason: string | null }
  | { state: "expired"; stopsByMs: number }
  | { state: "unknown" };

type JournalEntry =
  | {
      t: "create";
      id: string;
      grant_id: string;
      client_id: string;
      subject_id: string;
      training_expires_at_ms: number;
      at: number;
    }
  | {
      t: "issue";
      id: string;
      grant_id: string;
      jti: string;
      kid: string;
      iat_ms: number;
      exp_ms: number;
      node: string;
      /** B3: acquisition grants whose copies this lease covers, when named. */
      acq?: string[];
    }
  | {
      t: "tombstone";
      id: string;
      grant_id: string;
      reason: string;
      at: number;
    };

interface GrantFacts {
  create: Extract<JournalEntry, { t: "create" }> | null;
  maxExpMs: number | null;
  /** Journal sequence of the first tombstone, and T as the log defines it. */
  tombstone: {
    id: string;
    seq: number;
    reason: string;
    at: number;
    stopByMs: number;
  } | null;
}

/** A lifecycle erasure entry (lib/held-data), seen here only for B3 ordering. */
interface ErasureEntry {
  t: "erase";
  id: string;
  grant_id: string;
  at: number;
}

/**
 * Per-grant index over the shared authority journal. Each node keeps one and
 * reads only the bytes appended since its last read. Entry types this store
 * does not own (held-data lifecycle entries) are ignored, except erasures,
 * which bound lease issuance for the acquisition copies they cover (B3).
 */
class JournalIndex {
  readonly #reader: JournalReader<JournalEntry | ErasureEntry>;
  readonly grants = new Map<string, GrantFacts>();
  /** First erasure of each grant's copy, by journal sequence. */
  readonly erasures = new Map<string, { seq: number; at: number }>();
  /** B3: latest `exp` of a returnable lease naming each acquisition grant, before its erasure. */
  readonly acquisitionMaxExp = new Map<string, number>();
  /** Sequence numbers, only for entries this node is waiting on (see watch). */
  readonly #watched = new Map<string, number | null>();

  constructor(path: string) {
    this.#reader = new JournalReader(path);
  }

  watch(id: string): void {
    this.#watched.set(id, null);
  }

  /** Sequence of a watched entry once read; stops watching it. */
  takeSeq(id: string): number | undefined {
    const seq = this.#watched.get(id);
    this.#watched.delete(id);
    return seq ?? undefined;
  }

  facts(grantId: string): GrantFacts {
    let f = this.grants.get(grantId);
    if (!f) {
      f = { create: null, maxExpMs: null, tombstone: null };
      this.grants.set(grantId, f);
    }
    return f;
  }

  refresh(): void {
    this.#reader.refresh((e, seq) => this.#apply(e, seq));
  }

  #apply(e: JournalEntry | ErasureEntry, seq: number): void {
    if (this.#watched.has(e.id)) {
      this.#watched.set(e.id, seq);
    }
    if (e.t === "erase") {
      if (!this.erasures.has(e.grant_id)) {
        this.erasures.set(e.grant_id, { at: e.at, seq });
      }
      return;
    }
    if (e.t !== "create" && e.t !== "issue" && e.t !== "tombstone") {
      return;
    }
    const f = this.facts(e.grant_id);
    if (e.t === "create") {
      f.create ??= e;
    } else if (e.t === "issue") {
      // An issue entry after the tombstone is never returned to a client, so
      // it does not move T.
      if (!f.tombstone) {
        f.maxExpMs = Math.max(f.maxExpMs ?? 0, e.exp_ms);
        // A lease naming an acquisition grant that is already erased is never
        // returned (post-append check), so it does not move that grant's T.
        for (const a of e.acq ?? []) {
          if (!this.erasures.has(a)) {
            this.acquisitionMaxExp.set(a, Math.max(this.acquisitionMaxExp.get(a) ?? 0, e.exp_ms));
          }
        }
      }
    } else if (!f.tombstone) {
      f.tombstone = {
        id: e.id,
        seq,
        reason: e.reason,
        at: e.at,
        stopByMs: Math.max(f.maxExpMs ?? 0, e.at),
      };
    }
  }
}

function appendJournal(path: string, entry: JournalEntry): void {
  appendJournalEntry(path, entry);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS training_authority (
  grant_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  training_expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'withdrawn')),
  end_reason TEXT,
  max_exp_ms INTEGER,
  withdrawn_at_ms INTEGER,
  stop_by_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS training_lease_signing_keys (
  kid TEXT PRIMARY KEY,
  private_pem TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'revoked')),
  created_at_ms INTEGER NOT NULL,
  retired_at_ms INTEGER,
  max_exp_ms INTEGER
);
`;

export class TrainingAuthorityStore {
  readonly nodeId: string;
  readonly issuer: string;
  readonly #store: SqliteDatabase;
  readonly #journal: JournalIndex;
  readonly #o: AuthorityStoreOptions & { leaseLifetimeMs: number };

  private constructor(store: SqliteDatabase, opts: AuthorityStoreOptions) {
    this.#store = store;
    this.#o = {
      ...opts,
      leaseLifetimeMs: opts.leaseLifetimeMs ?? MAX_LEASE_LIFETIME_MS,
    };
    this.nodeId = opts.nodeId;
    this.issuer = opts.issuer;
    this.#journal = new JournalIndex(opts.journalPath);
  }

  static open(opts: AuthorityStoreOptions): TrainingAuthorityStore {
    if (opts.storePath === ":memory:") {
      throw new Error(
        "training authority store needs a file shared by every AS node",
      );
    }
    if (
      (opts.leaseLifetimeMs ?? MAX_LEASE_LIFETIME_MS) > MAX_LEASE_LIFETIME_MS
    ) {
      throw new Error("lease lifetime above the profile maximum (1 hour)");
    }
    const db = new Database(opts.storePath);
    db.pragma("journal_mode = WAL");
    db.pragma(`busy_timeout = ${Math.trunc(opts.busyTimeoutMs ?? 5000)}`);
    db.exec(SCHEMA);
    const s = new TrainingAuthorityStore(db, opts);
    s.#store.transaction(() => s.#replay()).immediate();
    s.#ensureSigningKey();
    return s;
  }

  /** Project every journal fact into the store. Idempotent; repairs a restored store. */
  #replay(): void {
    this.#journal.refresh();
    const insert = this.#store.prepare(
      `INSERT INTO training_authority(grant_id, client_id, subject_id, permission,
         training_expires_at_ms, state, created_at_ms)
       VALUES (?, ?, ?, ?, ?, 'active', ?) ON CONFLICT(grant_id) DO NOTHING`,
    );
    const raise = this.#store.prepare(
      "UPDATE training_authority SET max_exp_ms = MAX(COALESCE(max_exp_ms, 0), ?) WHERE grant_id = ?",
    );
    const end = this.#store.prepare(
      `UPDATE training_authority
          SET state = 'withdrawn', end_reason = ?, withdrawn_at_ms = ?, stop_by_ms = ?
        WHERE grant_id = ?`,
    );
    for (const [grantId, f] of this.#journal.grants) {
      if (f.create) {
        insert.run(
          grantId,
          f.create.client_id,
          f.create.subject_id,
          AI_TRAINING_PERMISSION,
          f.create.training_expires_at_ms,
          f.create.at,
        );
      }
      if (f.maxExpMs !== null) {
        raise.run(f.maxExpMs, grantId);
      }
      if (f.tombstone) {
        end.run(
          f.tombstone.reason,
          f.tombstone.at,
          f.tombstone.stopByMs,
          grantId,
        );
      }
    }
  }

  close(): void {
    this.#store.close();
  }

  /** Called at grant approval, before the grant itself commits. */
  createAuthority(input: {
    grantId: string;
    clientId: string;
    subjectId: string;
    trainingExpiresAtMs: number;
  }): void {
    this.#store
      .transaction(() => {
        appendJournal(this.#o.journalPath, {
          t: "create",
          id: randomUUID(),
          grant_id: input.grantId,
          client_id: input.clientId,
          subject_id: input.subjectId,
          training_expires_at_ms: input.trainingExpiresAtMs,
          at: this.#o.now(),
        });
        this.#replay();
      })
      .immediate();
  }

  get(grantId: string): AuthorityRow | null {
    return (
      (this.#store
        .prepare("SELECT * FROM training_authority WHERE grant_id = ?")
        .get(grantId) as AuthorityRow | undefined) ?? null
    );
  }

  /** L3 issuance. Returns no lease after any ending (L4). */
  issueLease(input: {
    grantId: string;
    clientId: string;
    /**
     * B3: acquisition grants whose copies the caller will train on. The
     * caller has already checked that each belongs to the same client and
     * owner and that the training grant covers it. Erased ones are dropped;
     * if none is left, no lease.
     */
    acquisitionGrantIds?: readonly string[];
  }): IssueOutcome {
    const now = this.#o.now();
    let committed: {
      entryId: string;
      jti: string;
      kid: string;
      iatS: number;
      expS: number;
      pem: string;
      acq: string[] | undefined;
    } | null = null;
    let failure: IssueRefusal | null = null;
    const requestedAcq = input.acquisitionGrantIds ? [...new Set(input.acquisitionGrantIds)] : undefined;
    try {
      this.#store
        .transaction(() => {
          this.#replay();
          const row = this.get(input.grantId);
          if (!row) {
            failure = "unknown_grant";
            return;
          }
          if (row.client_id !== input.clientId) {
            failure = "wrong_client";
            return;
          }
          if (row.state !== "active") {
            failure = "withdrawn";
            return;
          }
          if (now >= row.training_expires_at_ms) {
            failure = "expired";
            return;
          }
          const key = this.#store
            .prepare(
              "SELECT kid, private_pem FROM training_lease_signing_keys WHERE status = 'active' ORDER BY created_at_ms DESC LIMIT 1",
            )
            .get() as { kid: string; private_pem: string } | undefined;
          if (!key) {
            failure = "unavailable";
            return;
          }
          const iatS = Math.floor(now / 1000);
          const expS = Math.floor(
            Math.min(
              iatS * 1000 + this.#o.leaseLifetimeMs,
              row.training_expires_at_ms,
            ) / 1000,
          );
          if (expS <= iatS) {
            failure = "expired";
            return;
          }
          const acq = requestedAcq?.filter((a) => !this.#journal.erasures.has(a));
          if (requestedAcq && acq?.length === 0) {
            failure = "acquisition_erased";
            return;
          }
          const jti = randomUUID();
          const entryId = randomUUID();
          this.#journal.watch(entryId);
          appendJournal(this.#o.journalPath, {
            t: "issue",
            id: entryId,
            grant_id: row.grant_id,
            jti,
            kid: key.kid,
            iat_ms: iatS * 1000,
            exp_ms: expS * 1000,
            node: this.nodeId,
            ...(acq ? { acq } : {}),
          });
          this.#store
            .prepare(
              "UPDATE training_authority SET max_exp_ms = MAX(COALESCE(max_exp_ms, 0), ?) WHERE grant_id = ?",
            )
            .run(expS * 1000, row.grant_id);
          this.#store
            .prepare(
              "UPDATE training_lease_signing_keys SET max_exp_ms = MAX(COALESCE(max_exp_ms, 0), ?) WHERE kid = ?",
            )
            .run(expS * 1000, key.kid);
          committed = {
            entryId,
            jti,
            kid: key.kid,
            iatS,
            expS,
            pem: key.private_pem,
            acq,
          };
        })
        .immediate();
    } catch {
      // A node that cannot reach (or write) the record does not issue.
      return { ok: false, reason: "unavailable" };
    }
    if (failure) {
      return { ok: false, reason: failure };
    }
    const c = committed as unknown as {
      entryId: string;
      jti: string;
      kid: string;
      iatS: number;
      expS: number;
      pem: string;
      acq: string[] | undefined;
    };
    this.#o.afterIssueJournaledForTest?.();
    // Post-append check: a tombstone ordered before this `issue` entry (from a
    // node whose store copy this one never saw) means T excludes this lease.
    try {
      this.#journal.refresh();
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    const tomb = this.#journal.facts(input.grantId).tombstone;
    const mine = this.#journal.takeSeq(c.entryId);
    if (mine === undefined || (tomb && tomb.seq < mine)) {
      return { ok: false, reason: "withdrawn" };
    }
    // B3: an erasure ordered before this entry ends issuance for that copy.
    // The lease is not returned; the caller may ask again for the rest.
    if (c.acq?.some((a) => (this.#journal.erasures.get(a)?.seq ?? Number.POSITIVE_INFINITY) < mine)) {
      return { ok: false, reason: "acquisition_erased" };
    }
    const claims: LeaseClaimsOut = {
      iss: this.issuer,
      aud: input.clientId,
      jti: c.jti,
      grant_id: input.grantId,
      permission: AI_TRAINING_PERMISSION,
      iat: c.iatS,
      exp: c.expS,
      ...(c.acq ? { acq: c.acq } : {}),
    };
    const lease = signCompactJws(
      { typ: LEASE_JWS_TYP, kid: c.kid },
      claims as unknown as Record<string, unknown>,
      importPrivateKeyPem(c.pem),
    );
    return { ok: true, lease, claims, kid: c.kid };
  }

  /**
   * L3/L4 withdrawal. Decided by the journal alone: the tombstone append
   * (fsync) is the withdrawal, and T is read back from journal order. The
   * SQLite projection is updated afterwards, best effort, so issuance load
   * holding the store lock cannot delay a withdrawal.
   */
  withdraw(input: {
    grantId: string;
    reason: AuthorityEndReason;
  }): WithdrawOutcome {
    const now = this.#o.now();
    this.#journal.refresh();
    const facts = this.#journal.facts(input.grantId);
    if (!facts.create) {
      return { state: "unknown_grant" };
    }
    if (facts.tombstone) {
      return {
        state: "withdrawn",
        stopsByMs: facts.tombstone.stopByMs,
        alreadyWithdrawn: true,
      };
    }
    const tombstoneId = randomUUID();
    appendJournal(this.#o.journalPath, {
      t: "tombstone",
      id: tombstoneId,
      grant_id: input.grantId,
      reason: input.reason,
      at: now,
    });
    this.#o.afterTombstoneJournaledForTest?.();
    this.#journal.refresh();
    const tomb = this.#journal.facts(input.grantId).tombstone;
    try {
      this.sync();
    } catch {
      // The projection catches up on the next replay; the journal already decides.
    }
    return {
      state: "withdrawn",
      stopsByMs: tomb?.stopByMs ?? now,
      // Another node's tombstone may have been ordered first; it decides T.
      alreadyWithdrawn: tomb?.id !== tombstoneId,
    };
  }

  status(grantId: string): AuthorityStatus {
    this.#journal.refresh();
    const facts = this.#journal.facts(grantId);
    if (facts.tombstone) {
      return {
        state: "withdrawn",
        stopsByMs: facts.tombstone.stopByMs,
        endReason: facts.tombstone.reason,
      };
    }
    const row = this.get(grantId);
    if (!row) {
      return { state: "unknown" };
    }
    if (row.state === "withdrawn") {
      return {
        state: "withdrawn",
        stopsByMs: row.stop_by_ms ?? row.withdrawn_at_ms ?? 0,
        endReason: row.end_reason,
      };
    }
    if (this.#o.now() >= row.training_expires_at_ms) {
      return {
        state: "expired",
        stopsByMs: Math.max(row.max_exp_ms ?? 0, row.training_expires_at_ms),
      };
    }
    return {
      state: "active",
      maxExpMs: row.max_exp_ms,
      trainingExpiresAtMs: row.training_expires_at_ms,
    };
  }

  /**
   * B3: when training on one acquisition copy stops. After that copy's
   * erasure, no returned lease names it with a later `exp`. Null when no
   * lease ever named it.
   */
  acquisitionStopsBy(acquisitionGrantId: string): { stopsByMs: number | null; erasedAtMs: number | null } {
    this.#journal.refresh();
    return {
      erasedAtMs: this.#journal.erasures.get(acquisitionGrantId)?.at ?? null,
      stopsByMs: this.#journal.acquisitionMaxExp.get(acquisitionGrantId) ?? null,
    };
  }

  /** Re-read the journal into the store (another node may have written). */
  sync(): void {
    this.#store.transaction(() => this.#replay()).immediate();
  }

  /** Issuance records for one grant (L11, AS side), from the journal. */
  issuances(
    grantId: string,
  ): Array<{ jti: string; exp_ms: number; node: string }> {
    this.#journal.refresh();
    return this.#issueLog().filter((e) => e.grant_id === grantId);
  }

  #issueLog(): Array<Extract<JournalEntry, { t: "issue" }>> {
    // Prototype: a full read. A production journal needs an index and compaction.
    const fd = openSync(this.#o.journalPath, "a+");
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return buf
        .toString("utf8")
        .split("\n")
        .flatMap((l) => {
          try {
            const e = JSON.parse(l) as JournalEntry;
            return e.t === "issue" ? [e] : [];
          } catch {
            return [];
          }
        });
    } finally {
      closeSync(fd);
    }
  }

  // ----- L9 signing keys -----

  #ensureSigningKey(): void {
    this.#store
      .transaction(() => {
        if (
          !this.#store
            .prepare(
              "SELECT kid FROM training_lease_signing_keys WHERE status = 'active' LIMIT 1",
            )
            .get()
        ) {
          this.#insertKey();
        }
      })
      .immediate();
  }

  #insertKey(): string {
    const kp = generateEd25519KeyPair();
    const jwk: OkpPublicJwk = {
      ...kp.publicJwk,
      kid: kp.kid,
      use: "sig",
      alg: "EdDSA",
    };
    this.#store
      .prepare(
        "INSERT INTO training_lease_signing_keys(kid, private_pem, public_jwk_json, status, created_at_ms) VALUES (?, ?, ?, 'active', ?)",
      )
      .run(
        kp.kid,
        exportPrivateKeyPem(kp.privateKey),
        JSON.stringify(jwk),
        this.#o.now(),
      );
    return kp.kid;
  }

  /** Planned rotation: the old key stays published until its last lease expires. */
  rotateSigningKey(): string {
    let kid = "";
    this.#store
      .transaction(() => {
        this.#store
          .prepare(
            "UPDATE training_lease_signing_keys SET status = 'retired', retired_at_ms = ? WHERE status = 'active'",
          )
          .run(this.#o.now());
        kid = this.#insertKey();
      })
      .immediate();
    return kid;
  }

  /** Emergency revocation: the key leaves the JWKS at once. Workers that see this stop. */
  revokeSigningKey(kid: string): void {
    this.#store
      .prepare(
        "UPDATE training_lease_signing_keys SET status = 'revoked' WHERE kid = ?",
      )
      .run(kid);
    this.#ensureSigningKey();
  }

  jwks(): { keys: OkpPublicJwk[] } {
    const rows = this.#store
      .prepare(
        `SELECT public_jwk_json FROM training_lease_signing_keys
          WHERE status = 'active' OR (status = 'retired' AND COALESCE(max_exp_ms, 0) > ?)
          ORDER BY created_at_ms DESC`,
      )
      .all(this.#o.now()) as Array<{ public_jwk_json: string }>;
    return {
      keys: rows.map((r) => JSON.parse(r.public_jwk_json) as OkpPublicJwk),
    };
  }
}
