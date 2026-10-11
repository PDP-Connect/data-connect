// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AS-side held-data lifecycle authority (integration-v2 K1–K4).
 *
 * Everything here is a projection of the shared authority journal
 * (lib/authority-journal): grant registrations, status-credential digests,
 * grant endings with their disposition, erasure operations, and delivery,
 * receipt and completion records. Nothing is kept in a restorable store, so a
 * restore of the main database cannot roll back a terminal event, and status
 * answers are ordered against every entry this node has read.
 *
 * The lease store (lib/training-lease) reads the same journal and treats an
 * `erase` entry as ending lease issuance for that acquisition copy (B3).
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  appendJournalEntry,
  JournalReader,
  journalCoversEvidence,
  readLossEvidence,
  registerLossEvidence,
  withJournalLock,
  registerIssuanceFence,
  writeLossEvidence,
} from "../authority-journal/journal.ts";

import { PendingActions, type PendingAction } from "./pending-actions.ts";

export interface GrantRegistration {
  grantId: string;
  clientId: string;
  subjectId: string;
  confidential: boolean;
  trainingOnly?: boolean;
  streams: string[];
  expiresAtMs: number | null;
}

export type Disposition = "keep" | "delete";

/**
 * How a grant ended (integration-v2 §2, ending-path table). Expiry and refresh
 * replay are not endings recorded here: expiry is computed from `expires_at`,
 * and replay is a credential event.
 */
export type EndingPath =
  | "owner_withdrawal"
  | "client_disconnect"
  | "package_disconnect"
  | "one_child_withdrawal"
  | "narrowing"
  | "client_revocation"
  | "security_revocation"
  | "decommission"
  /** The grant ended before the lifecycle journal saw it (flag turned on over existing data). */
  | "unrecorded";

const OWNER_PATHS: ReadonlySet<EndingPath> = new Set([
  "owner_withdrawal",
  "client_disconnect",
  "package_disconnect",
  "one_child_withdrawal",
  "narrowing",
  "decommission",
]);

/** Streams an erasure covers. `"all"` is the whole copy acquired under the grant. */
export type ErasureScope = { streams: "all" } | { streams: string[] };

export type CredentialKind = "access" | "refresh" | "status" | "recovery";

type Entry =
  | { t: "hd_pending_inbox"; id: string; grant_id: ""; inbox_epoch: string; at: number }
  | { t: "tombstone"; id: string; grant_id: string; reason: string; at: number }
  | { t: "hd_epoch"; id: string; grant_id: ""; at: number }
  | {
      t: "hd_grant";
      id: string;
      grant_id: string;
      client_id: string;
      subject_id: string;
      confidential: boolean;
      training_only: boolean;
      streams: string[];
      expires_at: number | null;
      at: number;
    }
  | {
      t: "hd_cred";
      id: string;
      grant_id: string;
      digest: string;
      kind: CredentialKind;
      jkt: string | null;
      at: number;
    }
  | {
      t: "hd_revoke_pending";
      id: string;
      grant_id: "";
      family_id: string;
      disposition: Disposition;
      reported_at?: number;
      at: number;
    }
  | { t: "hd_family_revoke"; id: string; grant_id: ""; family_id: string; at: number }
  | {
      t: "hd_cred_disable";
      id: string;
      grant_id: string;
      digest: string;
      reason: string;
      at: number;
    }
  | {
      t: "hd_end";
      id: string;
      grant_id: string;
      path: EndingPath;
      disposition: Disposition | null;
      owner_notice_required: boolean;
      at: number;
    }
  | {
      t: "erase";
      id: string;
      grant_id: string;
      scope: ErasureScope;
      origin: string;
      at: number;
    }
  | { t: "hd_keep"; id: string; grant_id: string; at: number }
  | {
      t: "hd_delivered" | "hd_receipt";
      id: string;
      grant_id: string;
      op: string;
      at: number;
    }
  | {
      t: "hd_complete";
      id: string;
      grant_id: string;
      op: string;
      outcome: "deleted" | "exception";
      detail: string | null;
      at: number;
      /** AS time the report arrived (`at` is the client-reported time). */
      received_at?: number;
    };

type GrantEntry = Extract<Entry, { t: "hd_grant" }>;
type EndEntry = Extract<Entry, { t: "hd_end" }>;
type EraseEntry = Extract<Entry, { t: "erase" }>;

interface ErasureFacts {
  entry: EraseEntry;
  seq: number;
  deliveredAt: number | null;
  receiptAt: number | null;
  completion: {
    at: number;
    outcome: "deleted" | "exception";
    detail: string | null;
  } | null;
  /**
   * `retained` reports (deletion complete except legally retained data), in
   * order. A later report with different terms corrects an earlier one
   * without overwriting it. None of them is completion.
   */
  retained: { reportedAt: number; receivedAt: number; detail: string | null }[];
}

interface GrantFacts {
  grant: GrantEntry;
  end: EndEntry | null;
  /** The owner chose keep after an ending that recorded no disposition. */
  keptAt: number | null;
  erasures: ErasureFacts[];
}

interface CredentialFacts {
  grantIds: Set<string>;
  clientId: string;
  kind: CredentialKind;
  jkt: string | null;
  disabled: string | null;
}

/** The answer for one grant, before mapping to the Core wire (server/routes/held-data.ts). */
export interface StatusAnswer {
  grant_id: string;
  /** Read state only. It is not the ordinary-use assessment. */
  grant_state: "active" | "expired" | "ended";
  ending: {
    path: EndingPath;
    ended_at: number;
    disposition: Disposition | null;
    owner_notice_required: boolean;
  } | null;
  erasures: {
    operation_id: string;
    scope: ErasureScope;
    accepted_at: number;
  }[];
  /**
   * `permitted`: ordinary use may continue for data no listed erasure covers.
   * `stopped`: an erasure covers the whole copy. `custody_only`: a
   * training-only grant; keeping it never permits ordinary use (A1 F4).
   */
  ordinary_use: "permitted" | "stopped" | "custody_only";
  assessed_at: number;
  /** The grant's `expires_at`, if any. */
  expires_at: number | null;
  /** Journal position this answer is ordered after. */
  as_position: number;
}

export type StatusResult = StatusAnswer | { grant_id: string; error: "invalid_grant" };

/** An authenticated status reader. Built by `authenticateRead`. */
export interface ReadPrincipal {
  clientId: string;
  grantIds: ReadonlySet<string>;
  /** Client authentication was presented (confidential clients may batch). */
  clientAuthenticated: boolean;
}

export class DispositionError extends Error {
  readonly code = "disposition_required";
}

export class AuthorityUnavailableError extends Error {
  readonly code = "temporarily_unavailable";
}

export interface HeldDataAuthorityOptions {
  journalPath: string;
  now: () => number;
  /**
   * Replica mode. Returns the primary journal's current length in entries, or
   * null when the primary cannot be reached. A replica gives a positive answer
   * only when its own view is at least that long.
   */
  primaryHead?: () => number | null;
  /**
   * A small file in the restorable data directory naming the journal's epoch.
   * If it names an epoch the journal does not have, the journal was lost and
   * the authority fails closed (K4) instead of starting a new history.
   */
  epochMarkerPath?: string;
  /** Pending inbox outside the journal failure/restore domain. */
  pendingPath?: string;
  /** Loss witness outside the pending inbox failure/restore domain. */
  pendingEvidencePath?: string;
}

export function credentialDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** D4 pending actions live in a separate durable inbox until the operator replays them. */
export class HeldDataAuthority {
  readonly #o: HeldDataAuthorityOptions;
  #reader: JournalReader<Entry>;
  readonly #pending: PendingActions | null;
  #replaying = false;
  readonly #entryIds = new Set<string>();
  readonly #grants = new Map<string, GrantFacts>();
  readonly #creds = new Map<string, CredentialFacts>();
  readonly #ops = new Map<string, { grantId: string; index: number }>();
  /** Digests disabled for lifecycle compromise, whether or not registered. */
  readonly #disabled = new Map<string, string>();
  readonly #revokedFamilies = new Set<string>();
  readonly #pendingRevocations = new Map<string, Extract<Entry, { t: "hd_revoke_pending" }>>();
  #corrupt = false;
  #position = 0;
  #epoch: string | null = null;
  #pendingEpoch: string | null = null;
  #pendingHistoryLost = false;
  /** Set when the epoch marker names a history this journal does not hold. */
  #lostHistory: boolean;

  /**
   * The authority cannot establish its terminal-event history: the journal
   * the epoch marker names is gone, or a complete journal line is unreadable.
   * Every answer and write then fails closed.
   */
  get lost(): boolean {
    if (this.#lostHistory || this.#corrupt || (!this.#o.primaryHead && !journalCoversEvidence(this.#o.journalPath))) {
      return true;
    }
    if (this.#pendingHistoryLost || this.#pending?.lost) return true;
    return !this.#replaying && (this.#pending?.pending().length ?? 0) > 0;
  }

  private constructor(o: HeldDataAuthorityOptions) {
    this.#o = o;
    if (o.pendingPath === o.journalPath || (o.pendingEvidencePath && o.pendingEvidencePath === o.pendingPath)) {
      throw new Error("pending actions and loss evidence require separate storage paths");
    }
    this.#reader = new JournalReader<Entry>(o.journalPath);
    this.#refresh();
    const evidence = o.epochMarkerPath ? readLossEvidence(o.epochMarkerPath) : null;
    if (o.epochMarkerPath && !o.primaryHead) {
      registerLossEvidence(o.journalPath, o.epochMarkerPath);
    }
    // Lost: the evidence names another history, or this journal is shorter
    // than the evidence (an acknowledged terminal event was rolled back).
    this.#lostHistory =
      evidence !== null &&
      (evidence.epoch !== this.#epoch || !existsSync(o.journalPath) || statSync(o.journalPath).size < evidence.bytes);
    const existingPending = !!(
      (o.pendingPath && existsSync(o.pendingPath)) ||
      (o.pendingEvidencePath && existsSync(o.pendingEvidencePath))
    );
    this.#pending = o.pendingPath && o.pendingEvidencePath
      ? new PendingActions(o.pendingPath, o.pendingEvidencePath, !this.#lostHistory && !this.#corrupt && !this.#pendingEpoch)
      : null;
    // A surviving inbox is also evidence of an earlier authority generation.
    // Never adopt it as fresh after losing the journal and its terminal witness.
    this.#pendingHistoryLost =
      (existingPending && this.#pendingEpoch === null && !this.#lostHistory) ||
      (this.#pendingEpoch !== null && this.#pendingEpoch !== this.#pending?.epoch);
    if (!(this.lost || this.#epoch || o.primaryHead)) {
      const id = `hdepoch_${randomUUID()}`;
      this.#append({ t: "hd_epoch", id, grant_id: "", at: o.now() });
    }
    if (!this.lost && o.epochMarkerPath && this.#epoch && !o.primaryHead && evidence?.epoch !== this.#epoch) {
      writeLossEvidence(o.epochMarkerPath, { epoch: this.#epoch, bytes: statSync(o.journalPath).size });
    }
    if (!this.lost && this.#pending && !this.#pendingEpoch && !o.primaryHead) {
      const inboxEpoch = this.#pending.epoch;
      if (!inboxEpoch) throw new AuthorityUnavailableError("pending inbox cannot be initialized");
      this.#append({ t: "hd_pending_inbox", id: randomUUID(), grant_id: "", inbox_epoch: inboxEpoch, at: o.now() });
    }
    if (!o.primaryHead) registerIssuanceFence(o.journalPath, () => !this.lost && !this.#replaying);
  }

  static open(o: HeldDataAuthorityOptions): HeldDataAuthority {
    if (o.epochMarkerPath && !o.primaryHead) {
      return withJournalLock(o.journalPath, () => new HeldDataAuthority(o));
    }
    return new HeldDataAuthority(o);
  }

  #ordered<T>(run: () => T): T {
    return this.#o.epochMarkerPath && !this.#o.primaryHead ? withJournalLock(this.#o.journalPath, run) : run();
  }

  get position(): number {
    this.#refresh();
    return this.#position;
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  registerGrant(g: GrantRegistration): void {
    this.#requireWritable();
    this.#refresh();
    if (this.#grants.has(g.grantId)) {
      return;
    }
    this.#append({
      t: "hd_grant",
      id: randomUUID(),
      grant_id: g.grantId,
      client_id: g.clientId,
      subject_id: g.subjectId,
      confidential: g.confidential,
      training_only: g.trainingOnly ?? false,
      streams: [...g.streams],
      expires_at: g.expiresAtMs,
      at: this.#o.now(),
    });
  }

  /** Record a digest of a token issued for one or more grants (K3: digests, not tokens). */
  recordCredential(c: { token: string; grantIds: readonly string[]; kind: CredentialKind; jkt?: string | null }): void {
    this.#requireWritable();
    const digest = credentialDigest(c.token);
    for (const grantId of c.grantIds) {
      this.#append({
        t: "hd_cred",
        id: randomUUID(),
        grant_id: grantId,
        digest,
        kind: c.kind,
        jkt: c.jkt ?? null,
        at: this.#o.now(),
      });
    }
  }

  /** Disable one credential for lifecycle compromise. Other credentials of the grant survive. */
  disableCredential(token: string, reason = "lifecycle_compromise"): void {
    this.#requireWritable();
    this.#refresh();
    const digest = credentialDigest(token);
    if (this.#disabled.has(digest)) {
      return;
    }
    // Recorded by digest even when the journal has not seen the credential
    // yet (registration is lazy), so a later registration stays disabled.
    const cred = this.#creds.get(digest);
    this.#append({
      t: "hd_cred_disable",
      id: randomUUID(),
      grant_id: cred ? ([...cred.grantIds][0] ?? "") : "",
      digest,
      reason,
      at: this.#o.now(),
    });
  }

  /** Persist the authenticated disposition before applying package children. */
  recordPendingRevocation(familyId: string, disposition: Disposition, reportedAt?: number): void {
    this.#requireWritable();
    this.#refresh();
    if (!this.#pendingRevocations.has(familyId)) {
      this.#append({
        t: "hd_revoke_pending",
        id: randomUUID(),
        grant_id: "",
        family_id: familyId,
        disposition,
        ...(reportedAt === undefined ? {} : { reported_at: reportedAt }),
        at: this.#o.now(),
      });
    }
  }

  pendingRevocation(familyId: string): { disposition: Disposition; reportedAt?: number } | null {
    this.#refresh();
    const pending = this.#revokedFamilies.has(familyId) ? null : this.#pendingRevocations.get(familyId);
    return pending
      ? {
          disposition: pending.disposition,
          ...(pending.reported_at === undefined ? {} : { reportedAt: pending.reported_at }),
        }
      : null;
  }

  /** Refresh-family revocation is separate from the grants it covers (Core P1a/P5). */
  revokeRefreshFamily(familyId: string): void {
    this.#requireWritable();
    this.#refresh();
    if (!this.#revokedFamilies.has(familyId)) {
      this.#append({ t: "hd_family_revoke", id: randomUUID(), grant_id: "", family_id: familyId, at: this.#o.now() });
    }
  }

  refreshFamilyRevoked(familyId: string): boolean {
    this.#refresh();
    return this.#revokedFamilies.has(familyId);
  }

  /**
   * Replace lifecycle authentication after a compromise (K3), with no new
   * data grant and no read access. Proof is one of: possession of a DPoP key
   * that a credential of the grant was bound to; confidential client
   * authentication; or a one-time recovery code the owner handed to the
   * client. Returns a status-only credential, which the RS never accepts, or
   * null when no proof holds.
   */
  replaceStatusCredential(input: {
    grantId: string;
    jkt?: string | null;
    clientId?: string | null;
    recoveryCode?: string | null;
  }): string | null {
    this.#requireWritable();
    this.#refresh();
    const facts = this.#grants.get(input.grantId);
    if (!facts) {
      return null;
    }
    const creds = [...this.#creds.values()].filter((c) => c.grantIds.has(input.grantId));
    let jkt: string | null = null;
    if (input.jkt && creds.some((c) => c.jkt === input.jkt && c.kind !== "recovery")) {
      jkt = input.jkt;
    } else if (input.clientId && facts.grant.confidential && input.clientId === facts.grant.client_id) {
      jkt = null;
    } else if (input.recoveryCode) {
      const rc = this.#creds.get(credentialDigest(input.recoveryCode));
      if (rc?.kind !== "recovery" || rc.disabled || !rc.grantIds.has(input.grantId)) {
        return null;
      }
      this.disableCredential(input.recoveryCode, "recovery_code_used");
    } else {
      return null;
    }
    const token = `hdsc_${randomUUID()}${randomUUID()}`.replaceAll("-", "");
    this.recordCredential({ token, grantIds: [input.grantId], kind: "status", jkt });
    return token;
  }

  /** Owner action: a one-time code the owner gives the client to recover lifecycle authentication. */
  ownerRecoveryCode(grantId: string): string {
    const code = `hdrc_${randomUUID()}`.replaceAll("-", "");
    this.recordCredential({ token: code, grantIds: [grantId], kind: "recovery" });
    return code;
  }

  /**
   * Record a grant ending (K1). Owner paths need a disposition; a security
   * revocation must not carry one and records that the owner must be told.
   * Ending an already-ended grant records nothing new, but a `delete`
   * disposition still creates (or returns) an erasure operation (A1 F6).
   */
  end(input: {
    grantId: string;
    path: EndingPath;
    disposition?: Disposition | null;
    /** Main-database identity when the lost journal cannot supply it. */
    grant?: GrantRegistration;
  }): {
    endedAt: number;
    erasure: { operationId: string; acceptedAt: number } | null;
    pending?: boolean;
    actionId?: string;
  } {
    const disposition = input.disposition ?? null;
    if (OWNER_PATHS.has(input.path) && disposition === null) {
      throw new DispositionError(`a ${input.path} needs a keep or delete disposition`);
    }
    if (input.path === "security_revocation" && disposition !== null) {
      throw new DispositionError("a security revocation records no disposition; the owner chooses later");
    }
    this.#refresh();
    if (this.lost) {
      const action = this.#queue(input.grantId, "end", input.path, disposition, input.grant);
      return {
        endedAt: action.acceptedAt,
        erasure: action.erasureId ? { operationId: action.erasureId, acceptedAt: action.acceptedAt } : null,
        pending: true,
        actionId: action.id,
      };
    }
    this.#requireWritable();
    const facts = this.#grants.get(input.grantId);
    if (!facts) {
      throw new Error(`unknown grant ${input.grantId}`);
    }
    if (!facts.end) {
      this.#append({
        t: "hd_end",
        id: randomUUID(),
        grant_id: input.grantId,
        path: input.path,
        disposition,
        owner_notice_required: input.path === "security_revocation",
        at: this.#o.now(),
      });
    }
    const endedAt = this.#grants.get(input.grantId)?.end?.at ?? this.#o.now();
    if (disposition !== "delete") {
      return { endedAt, erasure: null };
    }
    // One instruction covers all held data of the grant, narrowing included
    // (Core). The client reads again under the new grant what it still needs.
    return { endedAt, erasure: this.requestErasure({ grantId: input.grantId, origin: input.path }) };
  }

  /** Record that a grant had already ended in the main database before the journal saw it. */
  markEndedBeforeTracking(grantId: string, endedAtMs: number): void {
    this.#requireWritable();
    this.#refresh();
    const facts = this.#grants.get(grantId);
    if (facts && !facts.end) {
      this.#append({
        t: "hd_end",
        id: randomUUID(),
        grant_id: grantId,
        path: "unrecorded",
        disposition: null,
        owner_notice_required: true,
        at: endedAtMs,
      });
    }
  }

  /** The kind a credential was recorded as, or null if unknown. */
  credentialKind(token: string): CredentialKind | null {
    this.#refresh();
    return this.#creds.get(credentialDigest(token))?.kind ?? null;
  }

  /** True if this token was disabled for lifecycle compromise. */
  isDisabled(token: string): boolean {
    this.#refresh();
    return this.#disabled.has(credentialDigest(token));
  }

  /**
   * Accept an erasure instruction (K2). Terminal: nothing cancels it. If an
   * accepted operation already covers the scope, that operation is returned,
   * so a retry or redelivery never starts a new clock. Otherwise this is a new
   * operation with its own acceptance time.
   */
  requestErasure(input: { grantId: string; scope?: ErasureScope; origin: string }): {
    operationId: string;
    acceptedAt: number;
  } {
    return this.#ordered(() => this.#requestErasure(input));
  }

  #requestErasure(input: Parameters<HeldDataAuthority["requestErasure"]>[0]): {
    operationId: string;
    acceptedAt: number;
  } {
    this.#requireWritable();
    this.#refresh();
    const facts = this.#grants.get(input.grantId);
    if (!facts) {
      throw new Error(`unknown grant ${input.grantId}`);
    }
    const scope = input.scope ?? { streams: "all" };
    const covering = facts.erasures.find((e) => scopeCovers(e.entry.scope, scope));
    if (covering) {
      return { operationId: covering.entry.id, acceptedAt: covering.entry.at };
    }
    const id = `hdop_${randomUUID()}`;
    const at = this.#o.now();
    this.#append({ t: "erase", id, grant_id: input.grantId, scope, origin: input.origin, at });
    return { operationId: id, acceptedAt: at };
  }

  /** Owner disposition after a path that recorded none (security revocation), or a later erase. */
  elect(input: { grantId: string; disposition: Disposition }): { operationId: string; acceptedAt: number } | null {
    if (this.lost) {
      const a = this.#queue(input.grantId, "elect", "owner_withdrawal", input.disposition);
      return a.erasureId ? { operationId: a.erasureId, acceptedAt: a.acceptedAt } : null;
    }
    if (input.disposition === "keep") {
      this.#requireWritable();
      this.#refresh();
      const facts = this.#grants.get(input.grantId);
      if (facts && facts.keptAt === null && facts.erasures.length === 0) {
        this.#append({ t: "hd_keep", id: randomUUID(), grant_id: input.grantId, at: this.#o.now() });
      }
      return null;
    }
    return this.requestErasure({ grantId: input.grantId, origin: "owner_election" });
  }

  /**
   * Client write (K3: current client authentication only; the caller checks
   * it). `receipt` is the client's first authenticated receipt, which starts
   * the deletion clock; `completion` reports disposal.
   */
  report(input: {
    clientId: string;
    grantId: string;
    operationId: string;
    kind: "receipt" | "completion" | "retained";
    /** Legacy form of `retained`: `completion` with outcome `exception`. */
    outcome?: "deleted" | "exception";
    detail?: string;
    /** Client-reported time of the event (Core `reported_at`). Default: now. */
    reportedAt?: number;
  }): boolean {
    this.#requireWritable();
    this.#refresh();
    const facts = this.#grants.get(input.grantId);
    const op = this.#ops.get(input.operationId);
    if (!facts || facts.grant.client_id !== input.clientId || op?.grantId !== input.grantId) {
      return false;
    }
    const e = facts.erasures[op.index];
    if (!e) {
      return false;
    }
    if (input.kind === "receipt") {
      if (e.receiptAt === null) {
        this.#append({
          t: "hd_receipt",
          id: randomUUID(),
          grant_id: input.grantId,
          op: input.operationId,
          at: input.reportedAt ?? this.#o.now(),
        });
      }
      return true;
    }
    const retained = input.kind === "retained" || input.outcome === "exception";
    const detail = input.detail ?? null;
    if (retained) {
      // Each retained report with new terms is kept; an identical repeat changes nothing.
      if (e.retained.at(-1)?.detail !== detail) {
        this.#append({
          t: "hd_complete",
          id: randomUUID(),
          grant_id: input.grantId,
          op: input.operationId,
          outcome: "exception",
          detail,
          at: input.reportedAt ?? this.#o.now(),
          received_at: this.#o.now(),
        });
      }
      return true;
    }
    if (e.completion === null) {
      this.#append({
        t: "hd_complete",
        id: randomUUID(),
        grant_id: input.grantId,
        op: input.operationId,
        outcome: "deleted",
        detail,
        at: input.reportedAt ?? this.#o.now(),
        received_at: this.#o.now(),
      });
    }
    return true;
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Authenticate a status read (K3). Any recorded access, refresh or status
   * credential works, whatever its read state, unless it was disabled for
   * lifecycle compromise. A DPoP-bound credential needs a proof by its key.
   * A confidential client must also authenticate. Returns null on any failure.
   */
  authenticateRead(input: {
    token?: string | null;
    dpopJkt?: string | null;
    clientId?: string | null;
  }): ReadPrincipal | null {
    this.#refresh();
    if (this.lost) {
      throw new AuthorityUnavailableError("authority history cannot be established");
    }
    if (!input.token) {
      if (!input.clientId) {
        return null;
      }
      const grantIds = new Set<string>();
      for (const [id, f] of this.#grants) {
        // Client authentication proves the client; each grant issued to it is authorized.
        if (f.grant.client_id === input.clientId) {
          grantIds.add(id);
        }
      }
      return { clientId: input.clientId, grantIds, clientAuthenticated: true };
    }
    const cred = this.#creds.get(credentialDigest(input.token));
    if (!cred || cred.disabled || cred.kind === "recovery") {
      return null;
    }
    if (cred.jkt && cred.jkt !== input.dpopJkt) {
      return null;
    }
    const grantIds = new Set<string>();
    for (const id of cred.grantIds) {
      const g = this.#grants.get(id)?.grant;
      if (g?.confidential && input.clientId !== g.client_id) {
        continue;
      }
      grantIds.add(id);
    }
    return { clientId: cred.clientId, grantIds, clientAuthenticated: Boolean(input.clientId) };
  }

  /**
   * The grant-status operation (K3/K4). Unknown and foreign grants get the
   * same failure. Only a client-authenticated (confidential) reader may batch.
   * Serving an erasure records its delivery.
   */
  status(principal: ReadPrincipal, grantIds: readonly string[]): StatusResult[] {
    return this.#ordered(() => this.#status(principal, grantIds));
  }

  #status(principal: ReadPrincipal, grantIds: readonly string[]): StatusResult[] {
    if (this.lost) {
      throw new AuthorityUnavailableError("authority history was lost; no lifecycle answer can be given");
    }
    if (grantIds.length > 1 && !principal.clientAuthenticated) {
      return grantIds.map((grant_id) => ({ grant_id, error: "invalid_grant" as const }));
    }
    this.#refresh();
    const now = this.#o.now();
    const head = this.#o.primaryHead?.();
    const current = this.#o.primaryHead === undefined || (head !== null && head !== undefined && this.#position >= head);
    const out: StatusResult[] = [];
    for (const grantId of grantIds) {
      const facts = this.#grants.get(grantId);
      if (!(facts && principal.grantIds.has(grantId) && facts.grant.client_id === principal.clientId)) {
        out.push({ grant_id: grantId, error: "invalid_grant" });
        continue;
      }
      const answer = this.#answer(facts, now);
      // K4: a positive answer must be ordered against every acknowledged
      // terminal event. A replica that cannot show it is current may still
      // serve a negative answer, which is terminal and cannot go stale.
      // Custody-only is a positive assessment too (it refreshes the long-stop),
      // so only an erasure answer may come from a view that cannot be shown current.
      if (answer.ordinary_use !== "stopped" && !current) {
        throw new AuthorityUnavailableError("replica cannot confirm it is current");
      }
      out.push(answer);
    }
    if (this.#o.primaryHead === undefined) {
      for (const r of out) {
        if ("erasures" in r) {
          this.#recordDeliveries(r.grant_id, now);
        }
      }
    }
    return out;
  }

  /**
   * Owner-facing record (K2/K4). A deletion date is shown only once the
   * client's receipt is recorded; until then the owner sees acceptance and
   * delivery only.
   */
  ownerView(
    grantId: string,
    deletionPeriodMs: number,
  ): {
    grant_state: StatusAnswer["grant_state"] | "unavailable";
    history_available: boolean;
    pending_actions: PendingAction[];
    ending: StatusAnswer["ending"];
    erasures: {
      operation_id: string;
      scope: ErasureScope;
      accepted_at: number;
      delivered_at: number | null;
      receipt_at: number | null;
      delete_by: number | null;
      completion: ErasureFacts["completion"];
      retained: ErasureFacts["retained"];
    }[];
  } | null {
    this.#refresh();
    const pending = this.#pendingHistoryLost || this.#pending?.lost ? [] : this.pendingActions(grantId);
    const staged = pending[0]?.grant;
    const facts =
      this.#grants.get(grantId) ??
      (staged
        ? {
            grant: this.#grantEntry(staged),
            end: null,
            keptAt: null,
            erasures: [],
          }
        : null);
    if (!facts) {
      return null;
    }
    const a = this.#answer(facts, this.#o.now());
    return {
      grant_state: this.lost ? "unavailable" : a.grant_state,
      history_available: !this.lost,
      pending_actions: pending,
      ending: a.ending,
      erasures: facts.erasures.map((e) => ({
        operation_id: e.entry.id,
        scope: e.entry.scope,
        accepted_at: e.entry.at,
        delivered_at: e.deliveredAt,
        receipt_at: e.receiptAt,
        delete_by: e.receiptAt === null ? null : e.receiptAt + deletionPeriodMs,
        completion: e.completion,
        retained: e.retained,
      })),
    };
  }

  /** True if the journal records an ending for this grant (read guard for a restored main database). */
  hasEnded(grantId: string): boolean {
    this.#refresh();
    return Boolean(this.#grants.get(grantId)?.end);
  }

  isKnown(grantId: string): boolean {
    this.#refresh();
    if (this.#grants.has(grantId)) return true;
    return !this.#pending?.lost && Boolean(this.#pending?.pending().some((a) => a.grant.grantId === grantId));
  }

  /**
   * A recovered lifecycle credential is current authentication for writes
   * (Core: "an unexpired lifecycle recovery token"). Returns its client.
   */
  statusCredentialClient(token: string, grantId: string): string | null {
    this.#refresh();
    const c = this.#creds.get(credentialDigest(token));
    return c && c.kind === "status" && !c.disabled && c.grantIds.has(grantId) ? c.clientId : null;
  }

  grantsOfClient(clientId: string): string[] {
    this.#refresh();
    return [...this.#grants.values()].filter((f) => f.grant.client_id === clientId).map((f) => f.grant.grant_id);
  }

  grantClient(grantId: string): string | null {
    this.#refresh();
    return this.#grants.get(grantId)?.grant.client_id ?? null;
  }

  /**
   * Operator path: restore the complete journal covered by the existing
   * evidence, then call this method (or reopen and call it). Never reset the
   * evidence to fit an older backup. Authority remains fenced until replay ends.
   */
  reestablishHistory(): void {
    this.#ordered(() => this.#reestablishHistory());
  }

  #reestablishHistory(): void {
    if (this.#o.primaryHead || this.#pending?.lost) throw new AuthorityUnavailableError("pending history unavailable");
    this.#replaying = true;
    this.#lostHistory = true;
    try {
      this.#reader = new JournalReader<Entry>(this.#o.journalPath);
      this.#grants.clear();
      this.#creds.clear();
      this.#ops.clear();
      this.#disabled.clear();
      this.#entryIds.clear();
      this.#position = 0;
      this.#epoch = null;
      this.#pendingEpoch = null;
      this.#corrupt = false;
      this.#refresh();
      const evidence = this.#o.epochMarkerPath ? readLossEvidence(this.#o.epochMarkerPath) : null;
      if (
        this.#corrupt ||
        readFileSync(this.#o.journalPath).at(-1) !== 10 ||
        !evidence ||
        evidence.epoch !== this.#epoch ||
        !journalCoversEvidence(this.#o.journalPath)
      ) {
        throw new AuthorityUnavailableError("restore the complete history covered by its evidence first");
      }
      if (this.#pending && this.#pendingEpoch !== this.#pending.epoch) {
        throw new AuthorityUnavailableError("restore the pending inbox matching the history's generation");
      }
      this.#pendingHistoryLost = false;
      for (const action of this.#pending?.pending() ?? []) {
        const grantId = action.grant.grantId;
        if (!this.#grants.has(grantId)) this.#append(this.#grantEntry(action.grant));
        if (action.kind === "end" && !this.#grants.get(grantId)?.end) {
          this.#append({
            t: "hd_end",
            id: `${action.id}_end`,
            grant_id: grantId,
            path: action.path,
            disposition: action.disposition,
            owner_notice_required: action.path === "security_revocation",
            at: action.acceptedAt,
          });
        }
        if (
          action.disposition === "delete" &&
          !this.#grants.get(grantId)?.erasures.some((e) => e.entry.scope.streams === "all")
        ) {
          if (!action.erasureId) throw new AuthorityUnavailableError("pending deletion has no instruction id");
          this.#append({
            t: "erase",
            id: action.erasureId,
            grant_id: grantId,
            scope: { streams: "all" },
            origin: action.path,
            at: action.acceptedAt,
          });
        } else if (action.kind === "elect" && action.disposition === "keep") {
          this.#append({
            t: "hd_keep",
            id: `${action.id}_keep`,
            grant_id: grantId,
            at: action.acceptedAt,
          });
        }
        if (action.kind === "end" && !this.#entryIds.has(`${action.id}_processing`)) {
          this.#append({
            t: "tombstone",
            id: `${action.id}_processing`,
            grant_id: grantId,
            reason: "grant_revoked",
            at: action.acceptedAt,
          });
        }
        // A crash before this durable marker replays the same entry IDs.
        this.#pending?.applied(action);
      }
      this.#lostHistory = false;
    } finally {
      this.#replaying = false;
    }
  }

  pendingActions(grantId?: string): PendingAction[] {
    if (this.#pendingHistoryLost || this.#pending?.lost) throw new AuthorityUnavailableError("pending history unavailable");
    const actions = this.lost ? this.#pending?.accepted() : this.#pending?.pending();
    return (actions ?? []).filter((a) => grantId === undefined || a.grant.grantId === grantId);
  }

  #grantEntry(g: GrantRegistration): GrantEntry {
    return {
      t: "hd_grant",
      id: randomUUID(),
      grant_id: g.grantId,
      client_id: g.clientId,
      subject_id: g.subjectId,
      confidential: g.confidential,
      training_only: g.trainingOnly ?? false,
      streams: [...g.streams],
      expires_at: g.expiresAtMs,
      at: this.#o.now(),
    };
  }

  #queue(
    grantId: string,
    kind: PendingAction["kind"],
    path: EndingPath,
    disposition: Disposition | null,
    supplied?: GrantRegistration,
  ): PendingAction {
    if (!this.#pending || this.#pendingHistoryLost || this.#pending.lost || this.#o.primaryHead)
      throw new AuthorityUnavailableError("an independent pending inbox is required");
    const g = this.#grants.get(grantId)?.grant;
    const grant =
      supplied ??
      this.#pending.pending().find((a) => a.grant.grantId === grantId)?.grant ??
      (g
        ? {
            grantId,
            clientId: g.client_id,
            subjectId: g.subject_id,
            confidential: g.confidential,
            trainingOnly: g.training_only,
            streams: g.streams,
            expiresAtMs: g.expires_at,
          }
        : null);
    if (!grant || grant.grantId !== grantId) throw new Error(`unknown grant ${grantId}`);
    return this.#pending.accept({
      grant,
      kind,
      path,
      disposition,
      acceptedAt: this.#o.now(),
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  #answer(facts: GrantFacts, now: number): StatusAnswer {
    const g = facts.grant;
    const wholeErased = facts.erasures.some((e) => e.entry.scope.streams === "all");
    let grantState: StatusAnswer["grant_state"] = "active";
    if (facts.end) {
      grantState = "ended";
    } else if (g.expires_at !== null && now >= g.expires_at) {
      grantState = "expired";
    }
    let ordinaryUse: StatusAnswer["ordinary_use"] = "permitted";
    if (wholeErased) {
      ordinaryUse = "stopped";
    } else if (g.training_only) {
      ordinaryUse = "custody_only";
    }
    return {
      grant_id: g.grant_id,
      grant_state: grantState,
      ending: facts.end
        ? {
            path: facts.end.path,
            ended_at: facts.end.at,
            disposition: facts.end.disposition,
            owner_notice_required: facts.end.owner_notice_required && facts.keptAt === null && facts.erasures.length === 0,
          }
        : null,
      erasures: facts.erasures.map((e) => ({
        operation_id: e.entry.id,
        scope: e.entry.scope,
        accepted_at: e.entry.at,
      })),
      ordinary_use: ordinaryUse,
      assessed_at: now,
      expires_at: g.expires_at,
      as_position: this.#position,
    };
  }

  #recordDeliveries(grantId: string, now: number): void {
    const facts = this.#grants.get(grantId);
    for (const e of facts?.erasures ?? []) {
      if (e.deliveredAt === null) {
        this.#append({ t: "hd_delivered", id: randomUUID(), grant_id: grantId, op: e.entry.id, at: now });
      }
    }
  }

  #requireWritable(): void {
    if (this.lost) {
      throw new AuthorityUnavailableError("authority history was lost");
    }
    if (this.#o.primaryHead) {
      throw new Error("a replica does not write");
    }
  }

  #append(e: Entry): void {
    appendJournalEntry(this.#o.journalPath, e);
    this.#refresh();
  }

  #refresh(): void {
    if (this.#corrupt) {
      return;
    }
    try {
      this.#reader.refresh((e, seq) => this.#apply(e, seq));
    } catch {
      // A terminal event may be in the unreadable line: fail closed.
      this.#corrupt = true;
    }
  }

  #apply(e: Entry, seq: number): void {
    this.#position = seq;
    if (this.#entryIds.has(e.id)) return;
    this.#entryIds.add(e.id);
    switch (e.t) {
      case "hd_pending_inbox":
        this.#pendingEpoch ??= e.inbox_epoch;
        return;
      case "hd_epoch":
        this.#epoch ??= e.id;
        return;
      case "hd_grant":
        if (!this.#grants.has(e.grant_id)) {
          this.#grants.set(e.grant_id, { grant: e, end: null, keptAt: null, erasures: [] });
        }
        return;
      case "hd_cred": {
        const g = this.#grants.get(e.grant_id);
        if (!g) {
          return;
        }
        const c = this.#creds.get(e.digest) ?? {
          grantIds: new Set<string>(),
          clientId: g.grant.client_id,
          kind: e.kind,
          jkt: e.jkt,
          disabled: this.#disabled.get(e.digest) ?? null,
        };
        c.grantIds.add(e.grant_id);
        this.#creds.set(e.digest, c);
        return;
      }
      case "hd_revoke_pending":
        if (!this.#pendingRevocations.has(e.family_id)) this.#pendingRevocations.set(e.family_id, e);
        return;
      case "hd_family_revoke":
        this.#revokedFamilies.add(e.family_id);
        return;
      case "hd_cred_disable": {
        if (!this.#disabled.has(e.digest)) {
          this.#disabled.set(e.digest, e.reason);
        }
        const c = this.#creds.get(e.digest);
        if (c) {
          c.disabled ??= e.reason;
        }
        return;
      }
      case "hd_keep": {
        const g = this.#grants.get(e.grant_id);
        if (g) {
          g.keptAt ??= e.at;
        }
        return;
      }
      case "hd_end": {
        const g = this.#grants.get(e.grant_id);
        if (g && !g.end) {
          g.end = e;
        }
        return;
      }
      case "erase": {
        const g = this.#grants.get(e.grant_id);
        if (g) {
          this.#ops.set(e.id, { grantId: e.grant_id, index: g.erasures.length });
          g.erasures.push({ entry: e, seq, deliveredAt: null, receiptAt: null, completion: null, retained: [] });
        }
        return;
      }
      case "hd_delivered":
      case "hd_receipt":
      case "hd_complete": {
        const op = this.#ops.get(e.op);
        const f = op ? this.#grants.get(op.grantId)?.erasures[op.index] : undefined;
        if (!f) {
          return;
        }
        if (e.t === "hd_complete") {
          if (e.outcome === "exception") {
            f.retained.push({ reportedAt: e.at, receivedAt: e.received_at ?? e.at, detail: e.detail });
          } else {
            f.completion ??= { at: e.at, outcome: e.outcome, detail: e.detail };
          }
        } else if (e.t === "hd_delivered") {
          f.deliveredAt ??= e.at;
        } else {
          f.receiptAt ??= e.at;
        }
        return;
      }
      default:
        // Entries owned by other stores (training leases) are not ours.
        return;
    }
  }
}

function scopeCovers(have: ErasureScope, want: ErasureScope): boolean {
  if (have.streams === "all") {
    return true;
  }
  if (want.streams === "all") {
    return false;
  }
  const covered = have.streams;
  return want.streams.every((s) => covered.includes(s));
}
