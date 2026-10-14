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
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  /** The grant's `retention.max_duration` (`PnD`), for the owner statement about the retention ceiling. */
  retentionMaxDuration?: string | null;
  /** When the AS issued the grant. Lets an invalidation on restore reach a grant the restored history never saw. */
  issuedAtMs?: number | null;
}

/** The end of a legal retention obligation, in the form the client gave (Core: Grant lifecycle operation). */
export type RetainedUntil =
  | { form: "date-time"; at: number }
  | { form: "event"; text: string }
  | { form: "unknown" };

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

/**
 * `recovery` is the lifecycle-only access token that lifecycle recovery issues
 * (Core: Lifecycle recovery). It authenticates the grant lifecycle operation
 * and nothing else.
 */
export type CredentialKind = "access" | "refresh" | "recovery";

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
      retention_max_duration?: string | null;
      issued_at?: number | null;
      at: number;
    }
  | {
      t: "hd_cred";
      id: string;
      grant_id: string;
      digest: string;
      kind: CredentialKind;
      jkt: string | null;
      /** Lifecycle-write expiry of a recovery token; queries ignore it. */
      expires_at?: number | null;
      /** The recovery approval a recovery token was issued under (one token per approval). */
      approval_id?: string;
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
      /** Why the AS ended the grant (security revocation), shown to the owner. */
      reason?: string;
      at: number;
    }
  | { t: "erase"; id: string; grant_id: string; scope: ErasureScope; origin: string; at: number; accepted_at?: number }
  | { t: "hd_advance"; id: string; grant_id: string; scope: ErasureScope; origin: string; at: number; effective_at: number | null }
  | { t: "hd_decommission_offer"; id: string; grant_id: ""; grants: string[]; at: number }
  | { t: "hd_decommission"; id: string; grant_id: ""; offer_id: string; at: number }
  | { t: "hd_window"; id: string; grant_id: string; window_end: number; at: number }
  | { t: "hd_access_revoke"; id: string; grant_id: string; digest: string; at: number }
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
      /** A `retained` report's structured terms. */
      retained?: { until: RetainedUntil; basis: string | null; scope: string | null };
      at: number;
      /** AS time the report arrived (`at` is the client-reported time). */
      received_at?: number;
    }
  /**
   * Restore procedure marker (Core: Lifecycle durability, mechanism
   * "invalidation on restore"): every grant the history held or issued before
   * `at` is not current until re-established.
   */
  | { t: "hd_invalidate"; id: string; grant_id: ""; reason: string; at: number }
  | { t: "hd_reestablish"; id: string; grant_id: string; at: number }
  /** Retained consent evidence for an approved lifecycle recovery. */
  | {
      t: "hd_recovery_approval";
      id: string;
      grant_id: "";
      client_id: string;
      subject_id: string;
      grant_ids: string[];
      shown: { grant_id: string; source: string | null; purpose: string | null; issued_at: string | null }[];
      at: number;
    };

type GrantEntry = Extract<Entry, { t: "hd_grant" }>;
type EndEntry = Extract<Entry, { t: "hd_end" }>;
type EraseEntry = Extract<Entry, { t: "erase" | "hd_advance" }>;

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
  retained: {
    reportedAt: number;
    receivedAt: number;
    detail: string | null;
    until: RetainedUntil | null;
    basis: string | null;
    scope: string | null;
  }[];
}

interface GrantFacts {
  grant: GrantEntry;
  readWindowEnd: number | null;
  end: EndEntry | null;
  /** The owner chose keep after an ending that recorded no disposition. */
  keptAt: number | null;
  erasures: ErasureFacts[];
  /** Journal position of the registration, and of the latest re-establishment after a restore. */
  regSeq: number;
  reestablishSeq: number;
}

interface CredentialFacts {
  grantIds: Set<string>;
  clientId: string;
  kind: CredentialKind;
  jkt: string | null;
  disabled: string | null;
  expiresAt: number | null;
}

/** The answer for one grant, before mapping to the Core wire (server/routes/held-data.ts). */
export interface StatusAnswer {
  grant_id: string;
  /** Read state only. It is not the ordinary-use assessment. */
  grant_state: "active" | "window_closed" | "expired" | "ended";
  ending: {
    path: EndingPath;
    ended_at: number;
    disposition: Disposition | null;
    owner_notice_required: boolean;
    reason?: string;
  } | null;
  erasures: { operation_id: string; scope: ErasureScope; accepted_at: number; effective_at?: number }[];
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

/**
 * How the AS keeps its terminal-event history safe across restore and
 * failover (Core: Lifecycle durability). The AS chooses and declares one.
 *
 * - `outside_witness`: loss-detection evidence kept outside the journal's
 *   failure domain. A journal shorter than the evidence, or of another epoch,
 *   is lost history and fails closed.
 * - `invalidate_on_restore`: one store, no outside witness. The operator
 *   restores it only through `HeldDataAuthority.restoreFromSnapshot`, which
 *   marks every grant not current until `reestablishGrants` recovers its facts.
 */
export type RestoreMechanism = "outside_witness" | "invalidate_on_restore";

export interface DurabilityDeclaration {
  mechanism: RestoreMechanism;
  survives: string[];
  does_not_survive: string[];
  undetected: string[];
  /** The text shown to the owner. */
  statement: string;
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
  readonly #revokedAccess = new Set<string>();
  readonly #revokedFamilies = new Set<string>();
  readonly #recoveryApprovals = new Map<string, Extract<Entry, { t: "hd_recovery_approval" }>>();
  readonly #recoveryIssued = new Set<string>();
  /** Restore-procedure markers (mechanism "invalidation on restore"), in journal order. */
  readonly #invalidations: { seq: number; at: number }[] = [];
  readonly #pendingRevocations = new Map<string, Extract<Entry, { t: "hd_revoke_pending" }>>();
  #corrupt = false;
  #position = 0;
  #epoch: string | null = null;
  #pendingEpoch: string | null = null;
  #pendingHistoryLost = false;
  #decommissionOffer: { id: string; grants: string[] } | null = null;
  #decommissioned = false;
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
    // Processing authority (training leases) is issued only from history that is current:
    // while a restore marker covers any grant the whole fence stays shut (fail closed).
    if (!o.primaryHead) {
      registerIssuanceFence(o.journalPath, () => !this.lost && !this.#replaying && this.invalidatedGrantIds().length === 0);
    }
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

  get journalPath(): string {
    return this.#o.journalPath;
  }

  get decommissioned(): boolean {
    this.#refresh();
    return this.#decommissioned;
  }

  allGrantIds(): string[] {
    this.#refresh();
    return [...this.#grants.keys()].sort();
  }

  /** Persist the complete set offered before the owner can retire lifecycle service. */
  offerDecommission(): { id: string; grants: string[] } {
    return this.#ordered(() => this.#offerDecommission());
  }

  #offerDecommission(): { id: string; grants: string[] } {
    this.#requireWritable();
    const grants = this.allGrantIds();
    const id = randomUUID();
    this.#append({ t: "hd_decommission_offer", id, grant_id: "", grants, at: this.#o.now() });
    return { id, grants };
  }

  decommissionOfferMatches(id: string, grants: string[]): boolean {
    this.#refresh();
    return this.#decommissionOffer?.id === id && JSON.stringify(this.#decommissionOffer.grants) === JSON.stringify([...grants].sort());
  }

  completeDecommission(offerId: string): void {
    this.#ordered(() => this.#completeDecommission(offerId));
  }

  #completeDecommission(offerId: string): void {
    this.#requireWritable();
    if (!this.decommissionOfferMatches(offerId, this.allGrantIds())) {
      throw new Error("decommission offer is stale");
    }
    this.#append({ t: "hd_decommission", id: randomUUID(), grant_id: "", offer_id: offerId, at: this.#o.now() });
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
      retention_max_duration: g.retentionMaxDuration ?? null,
      issued_at: g.issuedAtMs ?? null,
      at: this.#o.now(),
    });
  }

  /** Remember the first single-use read window; it never opens a second time. */
  recordReadWindow(grantId: string, windowEnd: number): void {
    this.#ordered(() => this.#recordReadWindow(grantId, windowEnd));
  }

  #recordReadWindow(grantId: string, windowEnd: number): void {
    this.#requireWritable();
    this.#refresh();
    const g = this.#grants.get(grantId);
    if (g && g.readWindowEnd === null && Number.isFinite(windowEnd)) {
      this.#append({ t: "hd_window", id: randomUUID(), grant_id: grantId, window_end: windowEnd, at: this.#o.now() });
    }
  }

  /** Record a digest of a token issued for one or more grants (K3: digests, not tokens). */
  recordCredential(c: {
    token: string;
    grantIds: readonly string[];
    kind: CredentialKind;
    jkt?: string | null;
    expiresAtMs?: number | null;
    approvalId?: string;
  }): void {
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
        ...(c.expiresAtMs === undefined ? {} : { expires_at: c.expiresAtMs }),
        ...(c.approvalId === undefined ? {} : { approval_id: c.approvalId }),
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

  /** Revoke data access and lifecycle writes; retain historical status-query authentication. */
  revokeAccessCredential(token: string): void {
    this.#requireWritable();
    this.#refresh();
    const digest = credentialDigest(token);
    if (!this.#revokedAccess.has(digest)) {
      this.#append({ t: "hd_access_revoke", id: randomUUID(), grant_id: "", digest, at: this.#o.now() });
    }
  }

  accessCredentialRevoked(token: string): boolean {
    this.#refresh();
    return this.#revokedAccess.has(credentialDigest(token));
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
   * Record the owner's approval of a lifecycle recovery as retained consent
   * evidence (Core: Lifecycle recovery): the client, the owner, the exact
   * grant identifier set, and what the owner was shown for each grant.
   * Returns the approval identifier a token issuance then names.
   */
  recordRecoveryApproval(input: {
    clientId: string;
    subjectId: string;
    grantIds: readonly string[];
    shown: { grant_id: string; source: string | null; purpose: string | null; issued_at: string | null }[];
  }): string {
    this.#requireWritable();
    this.#refresh();
    for (const id of input.grantIds) {
      const g = this.#grants.get(id)?.grant;
      if (!g || g.client_id !== input.clientId || g.subject_id !== input.subjectId) {
        throw new Error("a recovery covers only grants issued to the client for the owner");
      }
    }
    const id = `hdrec_${randomUUID()}`;
    this.#append({
      t: "hd_recovery_approval",
      id,
      grant_id: "",
      client_id: input.clientId,
      subject_id: input.subjectId,
      grant_ids: [...input.grantIds],
      shown: input.shown,
      at: this.#o.now(),
    });
    return id;
  }

  /**
   * Issue the lifecycle-only access token of an approved recovery, once. It
   * covers exactly the approved grants, carries no read or processing
   * authority, and has no refresh token.
   */
  issueRecoveryToken(approvalId: string, expiresAtMs: number | null): { token: string; grantIds: string[] } {
    this.#requireWritable();
    this.#refresh();
    const approval = this.#recoveryApprovals.get(approvalId);
    if (!approval || this.#recoveryIssued.has(approvalId)) {
      throw new Error("recovery approval is unknown or already used");
    }
    const token = `hdrt_${randomUUID()}${randomUUID()}`.replaceAll("-", "");
    this.recordCredential({ token, grantIds: approval.grant_ids, kind: "recovery", expiresAtMs, approvalId });
    return { token, grantIds: [...approval.grant_ids] };
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
    /** Why the AS ended the grant, for a security revocation. */
    reason?: string;
    /** Main-database identity when the lost journal cannot supply it. */
    grant?: GrantRegistration;
  }): {
    endedAt: number;
    erasure: { operationId: string; acceptedAt: number } | null;
    pending?: boolean;
    actionId?: string;
  } {
    return this.#ordered(() => this.#end(input));
  }

  #end(input: Parameters<HeldDataAuthority["end"]>[0]): ReturnType<HeldDataAuthority["end"]> {
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
        ...(input.reason ? { reason: input.reason } : {}),
        at: this.#o.now(),
      });
    }
    const endedAt = this.#grants.get(input.grantId)?.end?.at ?? this.#o.now();
    this.#activateAdvance(facts, endedAt);
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
      if (covering.entry.t === "hd_advance" && !facts.end &&
          (facts.grant.expires_at === null || this.#o.now() < facts.grant.expires_at)) {
        this.end({ grantId: input.grantId, path: "owner_withdrawal", disposition: "delete" });
      }
      return { operationId: covering.entry.id, acceptedAt: this.#acceptedAt(covering) };
    }
    const id = `hdop_${randomUUID()}`;
    const at = this.#o.now();
    this.#append({ t: "erase", id, grant_id: input.grantId, scope, origin: input.origin, at });
    return { operationId: id, acceptedAt: at };
  }

  /** Optional Core advance election: durable now, effective only at grant end. */
  electAdvance(grantId: string): { operationId: string; acceptedAt: number } {
    return this.#ordered(() => this.#electAdvance(grantId));
  }

  #electAdvance(grantId: string): { operationId: string; acceptedAt: number } {
    this.#requireWritable();
    this.#refresh();
    const facts = this.#grants.get(grantId);
    if (!facts) {
      throw new Error(`unknown grant ${grantId}`);
    }
    const existing = facts.erasures.find((e) => e.entry.scope.streams === "all");
    if (existing) {
      return { operationId: existing.entry.id, acceptedAt: this.#acceptedAt(existing) };
    }
    if (facts.end || (facts.grant.expires_at !== null && this.#o.now() >= facts.grant.expires_at)) {
      return this.requestErasure({ grantId, origin: "owner_election" });
    }
    const id = `hdop_${randomUUID()}`;
    const at = this.#o.now();
    this.#append({ t: "hd_advance", id, grant_id: grantId, scope: { streams: "all" },
      origin: "advance_election", at, effective_at: facts.grant.expires_at });
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
    /** The terms of a `retained` report (Core: `retained_until`, `retention_basis`, `retention_scope`). */
    retained?: { until: RetainedUntil; basis?: string | null; scope?: string | null };
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
    const effectiveAt = e ? this.#effectiveAt(facts, e) : null;
    if (!e || effectiveAt === null || effectiveAt > this.#o.now()) {
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
      const terms = input.retained
        ? { until: input.retained.until, basis: input.retained.basis ?? null, scope: input.retained.scope ?? null }
        : undefined;
      // Each retained report with new terms is kept as a correction that does
      // not overwrite the earlier one; an identical repeat changes nothing.
      const last = e.retained.at(-1);
      const same =
        last !== undefined &&
        last.detail === detail &&
        JSON.stringify([last.until, last.basis, last.scope]) ===
          JSON.stringify([terms?.until ?? null, terms?.basis ?? null, terms?.scope ?? null]);
      if (!same) {
        this.#append({
          t: "hd_complete",
          id: randomUUID(),
          grant_id: input.grantId,
          op: input.operationId,
          outcome: "exception",
          detail,
          ...(terms ? { retained: terms } : {}),
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
    if (!cred || cred.disabled) {
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
    if (this.decommissioned) {
      throw new AuthorityUnavailableError("AS is decommissioned; lifecycle service has retired");
    }
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
      // A view that cannot be shown current may return an instruction only
      // when it was durably effective: a stale advance election is never
      // promoted to an effective instruction by the passing of time.
      const stale = !current || this.invalidated(grantId);
      const answer = this.#answer(facts, now, stale);
      // K4: a positive answer must be ordered against every acknowledged
      // terminal event. A replica that cannot show it is current may still
      // serve a negative answer, which is terminal and cannot go stale.
      // Custody-only is a positive assessment too, so only an erasure answer
      // may come from a view that cannot be shown current.
      if (answer.ordinary_use !== "stopped" && stale) {
        throw new AuthorityUnavailableError("history cannot be shown current for this grant");
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
    /** `restored_not_current`: a restore marker covers the grant until its facts are re-established. */
    history_state: "current" | "unavailable" | "restored_not_current";
    retention_max_duration: string | null;
    pending_actions: PendingAction[];
    ending: StatusAnswer["ending"];
    erasures: {
      operation_id: string;
      scope: ErasureScope;
      accepted_at: number;
      effective_at: number | null;
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
            readWindowEnd: null,
            end: null,
            keptAt: null,
            erasures: [],
            regSeq: 0,
            reestablishSeq: 0,
          }
        : null);
    if (!facts) {
      return null;
    }
    const a = this.#answer(facts, this.#o.now());
    return {
      grant_state: this.lost ? "unavailable" : a.grant_state,
      history_available: !this.lost,
      history_state: this.lost ? "unavailable" : this.invalidated(grantId) ? "restored_not_current" : "current",
      retention_max_duration: facts.grant.retention_max_duration ?? null,
      pending_actions: pending,
      ending: a.ending,
      erasures: facts.erasures.map((e) => ({
        operation_id: e.entry.id,
        scope: e.entry.scope,
        accepted_at: this.#acceptedAt(e),
        effective_at: this.#effectiveAt(facts, e),
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
   * A lifecycle recovery token is current authentication for writes while it
   * is unexpired and not disabled (Core: Lifecycle recovery). Returns its client.
   */
  recoveryCredentialClient(token: string, grantId: string): string | null {
    this.#refresh();
    const c = this.#creds.get(credentialDigest(token));
    if (!c || c.kind !== "recovery" || c.disabled || !c.grantIds.has(grantId)) return null;
    if (c.expiresAt !== null && this.#o.now() >= c.expiresAt) return null;
    return c.clientId;
  }

  /** The owner subject a grant was issued for, or null. */
  grantSubject(grantId: string): string | null {
    this.#refresh();
    return this.#grants.get(grantId)?.grant.subject_id ?? null;
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
      this.#revokedAccess.clear();
      this.#invalidations.length = 0;
      this.#entryIds.clear();
      this.#position = 0;
      this.#epoch = null;
      this.#pendingEpoch = null;
      this.#decommissionOffer = null;
      this.#decommissioned = false;
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
        const restored = this.#grants.get(grantId);
        const acceleratesAdvance = action.kind === "elect" && action.disposition === "delete" &&
          !restored?.end && restored?.erasures.some((e) => e.entry.t === "hd_advance") &&
          (restored.grant.expires_at === null || action.acceptedAt < restored.grant.expires_at);
        const endsGrant = action.kind === "end" || acceleratesAdvance;
        if (endsGrant && !restored?.end) {
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
        const facts = this.#grants.get(grantId);
        if (facts?.end) this.#activateAdvance(facts, facts.end.at);
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
        } else if (action.disposition === "keep" && facts?.keptAt === null && facts.erasures.length === 0) {
          this.#append({
            t: "hd_keep",
            id: `${action.id}_keep`,
            grant_id: grantId,
            at: action.acceptedAt,
          });
        }
        if (endsGrant && !this.#entryIds.has(`${action.id}_processing`)) {
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

  // ─── Restore mechanism (Core: Lifecycle durability) ────────────────────────

  get mechanism(): RestoreMechanism {
    return this.#o.epochMarkerPath ? "outside_witness" : "invalidate_on_restore";
  }

  /**
   * Operator restore procedure of the `invalidate_on_restore` mechanism: put a
   * snapshot in place as the journal and, in the same atomic replace, append a
   * marker that makes every grant not current. A restore through any other
   * path leaves no marker and is not detected. Stop every writer first.
   */
  static restoreFromSnapshot(o: { journalPath: string; snapshotPath: string; now: () => number; reason?: string }): void {
    const bytes = readFileSync(o.snapshotPath);
    const end = bytes.lastIndexOf(10);
    const kept = end === -1 ? Buffer.alloc(0) : bytes.subarray(0, end + 1);
    const marker: Entry = { t: "hd_invalidate", id: randomUUID(), grant_id: "", reason: o.reason ?? "restore", at: o.now() };
    const tmp = `${o.journalPath}.restore`;
    writeFileSync(tmp, Buffer.concat([kept, Buffer.from(`${JSON.stringify(marker)}\n`)]));
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, o.journalPath);
    const dfd = openSync(dirname(o.journalPath), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  }

  /**
   * True while a restore marker covers the grant and its facts are not yet
   * re-established. A grant registered after the marker is covered only when
   * it was issued before the restore (or its issue time is unknown).
   */
  invalidated(grantId: string): boolean {
    this.#refresh();
    const f = this.#grants.get(grantId);
    if (!f) return false;
    return this.#invalidations.some(
      (inv) =>
        inv.seq > f.reestablishSeq &&
        (f.regSeq < inv.seq || f.grant.issued_at == null || f.grant.issued_at < inv.at),
    );
  }

  invalidatedGrantIds(): string[] {
    return this.allGrantIds().filter((id) => this.invalidated(id));
  }

  /** A lifecycle write is not authenticated from history that is not current. */
  requireCurrent(grantId: string): void {
    if (this.invalidated(grantId)) {
      throw new AuthorityUnavailableError("history for this grant was restored and is not re-established");
    }
  }

  /**
   * Make grants current again after a restore, from facts recovered outside
   * the restored history (the owner's re-confirmation, the main database, a
   * client's report). Each recovered ending or erasure is recorded first.
   */
  reestablishGrants(
    facts: { grantId: string; ended?: { path: EndingPath; disposition: Disposition | null }; erase?: boolean }[],
  ): void {
    this.#ordered(() => {
      this.#requireWritable();
      for (const f of facts) {
        if (!this.#grants.has(f.grantId)) throw new Error(`unknown grant ${f.grantId}`);
        if (f.ended && !this.hasEnded(f.grantId)) this.end({ grantId: f.grantId, ...f.ended });
        if (f.erase) this.requestErasure({ grantId: f.grantId, origin: "reestablished" });
        this.#append({ t: "hd_reestablish", id: randomUUID(), grant_id: f.grantId, at: this.#o.now() });
      }
    });
  }

  /**
   * What this AS survives, what it does not, and the rollbacks it cannot
   * detect, in words the owner can read. The AS claims no more than it keeps.
   */
  durability(): DurabilityDeclaration {
    const sameDevice = (() => {
      try {
        return this.#o.epochMarkerPath
          ? statSync(dirname(this.#o.journalPath)).dev === statSync(dirname(this.#o.epochMarkerPath)).dev
          : true;
      } catch {
        return true;
      }
    })();
    const common = ["a crash or restart of the AS: each terminal event is written to disk before it is acknowledged"];
    const decl: Omit<DurabilityDeclaration, "statement"> =
      this.mechanism === "outside_witness"
        ? {
            mechanism: "outside_witness",
            survives: [
              ...common,
              "restore or loss of the main database: the history is a separate store",
              "restore of the history to an older copy, or its loss, while the loss-detection evidence survives: the AS detects the shortfall and refuses positive answers and tokens",
            ],
            does_not_survive: [
              sameDevice
                ? "loss of the disk that holds both the history and its loss-detection evidence: they share one device here"
                : "loss of both the history and its loss-detection evidence",
              "loss of the host",
            ],
            undetected: [
              "a rollback that restores the history and its evidence together, such as a revert of a virtual-machine snapshot or a whole-disk restore",
              "a copy of the history placed outside the AS that never passes the evidence check",
            ],
          }
        : {
            mechanism: "invalidate_on_restore",
            survives: [
              ...common,
              "restore or loss of the main database: the history is a separate store",
              "restore of a snapshot through the declared restore procedure: every grant is then not current, and gets no positive answer, token, or write until its facts are re-established",
            ],
            does_not_survive: [
              "loss of the disk that holds the history: this AS keeps its history in a single store on a single disk and does not claim the record survives that loss",
              "loss of the host",
            ],
            undetected: [
              "any rollback or replacement of the history outside the declared restore procedure, such as a revert of a virtual-machine snapshot, a file copy of an older history, or a lost store recreated empty",
            ],
          };
    const statement = [
      `Restore mechanism: ${decl.mechanism === "outside_witness" ? "loss-detection evidence kept outside the history" : "invalidation on restore (one store, no outside witness)"}.`,
      `Survives: ${decl.survives.join("; ")}.`,
      `Does not survive: ${decl.does_not_survive.join("; ")}.`,
      `Not detected: ${decl.undetected.join("; ")}.`,
      "A rollback this AS does not detect, such as a revert of a virtual-machine snapshot, can revive revoked grants and lose recorded deletions.",
    ].join(" ");
    return { ...decl, statement };
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
      retention_max_duration: g.retentionMaxDuration ?? null,
      issued_at: g.issuedAtMs ?? null,
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
            retentionMaxDuration: g.retention_max_duration ?? null,
            issuedAtMs: g.issued_at ?? null,
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

  #answer(facts: GrantFacts, now: number, stale = false): StatusAnswer {
    const g = facts.grant;
    const effective = facts.erasures.filter((e) => {
      if (stale && e.entry.t !== "erase") return false;
      const at = this.#effectiveAt(facts, e);
      return at !== null && at <= now;
    });
    const wholeErased = effective.some((e) => e.entry.scope.streams === "all");
    let grantState: StatusAnswer["grant_state"] = "active";
    if (facts.end) {
      grantState = "ended";
    } else if (g.expires_at !== null && now >= g.expires_at) {
      grantState = "expired";
    } else if (facts.readWindowEnd !== null && now >= facts.readWindowEnd) {
      grantState = "window_closed";
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
            ...(facts.end.reason ? { reason: facts.end.reason } : {}),
          }
        : null,
      erasures: effective.map((e) => ({
        operation_id: e.entry.id,
        scope: e.entry.scope,
        accepted_at: this.#acceptedAt(e),
        effective_at: this.#effectiveAt(facts, e) ?? e.entry.at,
      })),
      ordinary_use: ordinaryUse,
      assessed_at: now,
      expires_at: g.expires_at,
      as_position: this.#position,
    };
  }

  #acceptedAt(e: ErasureFacts): number {
    return e.entry.t === "erase" ? e.entry.accepted_at ?? e.entry.at : e.entry.at;
  }

  #effectiveAt(facts: GrantFacts, e: ErasureFacts): number | null {
    if (e.entry.t === "erase") {
      return e.entry.at;
    }
    const times = [facts.end?.at, e.entry.effective_at].filter((t): t is number => typeof t === "number");
    return times.length ? Math.min(...times) : null;
  }

  #activateAdvance(facts: GrantFacts, endedAt: number): void {
    for (const e of facts.erasures) {
      if (e.entry.t === "hd_advance") {
        const effectiveAt = Math.min(endedAt, e.entry.effective_at ?? Number.POSITIVE_INFINITY);
        this.#append({ t: "erase", id: e.entry.id, grant_id: facts.grant.grant_id, scope: e.entry.scope,
          origin: e.entry.origin, at: effectiveAt, accepted_at: e.entry.at });
      }
    }
  }

  #recordDeliveries(grantId: string, now: number): void {
    const facts = this.#grants.get(grantId);
    for (const e of facts?.erasures ?? []) {
      const effectiveAt = facts ? this.#effectiveAt(facts, e) : null;
      if (e.deliveredAt === null && effectiveAt !== null && effectiveAt <= now) {
        this.#append({ t: "hd_delivered", id: randomUUID(), grant_id: grantId, op: e.entry.id, at: now });
      }
    }
  }

  #requireWritable(): void {
    if (this.decommissioned) {
      throw new AuthorityUnavailableError("AS is decommissioned");
    }
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
    // An advance election and its activation retain one operation ID, but
    // each is a distinct fact. Retried activations still apply only once.
    const entryId = e.t === "hd_advance" ? `advance:${e.id}` : e.id;
    if (this.#entryIds.has(entryId)) return;
    this.#entryIds.add(entryId);
    switch (e.t) {
      case "hd_pending_inbox":
        this.#pendingEpoch ??= e.inbox_epoch;
        return;
      case "hd_epoch":
        this.#epoch ??= e.id;
        return;
      case "hd_decommission_offer":
        this.#decommissionOffer = { id: e.id, grants: e.grants };
        return;
      case "hd_decommission":
        this.#decommissioned = true;
        return;
      case "hd_recovery_approval":
        this.#recoveryApprovals.set(e.id, e);
        return;
      case "hd_invalidate":
        this.#invalidations.push({ seq, at: e.at });
        return;
      case "hd_reestablish": {
        const g = this.#grants.get(e.grant_id);
        if (g) g.reestablishSeq = Math.max(g.reestablishSeq, seq);
        return;
      }
      case "hd_grant":
        if (!this.#grants.has(e.grant_id)) {
          this.#grants.set(e.grant_id, {
            grant: e,
            readWindowEnd: null,
            end: null,
            keptAt: null,
            erasures: [],
            regSeq: seq,
            reestablishSeq: 0,
          });
        }
        return;
      case "hd_window": {
        const g = this.#grants.get(e.grant_id);
        if (g) {
          g.readWindowEnd ??= e.window_end;
        }
        return;
      }
      case "hd_cred": {
        if (e.approval_id) this.#recoveryIssued.add(e.approval_id);
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
          expiresAt: e.expires_at ?? null,
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
      case "hd_access_revoke":
        this.#revokedAccess.add(e.digest);
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
      case "hd_advance":
      case "erase": {
        const g = this.#grants.get(e.grant_id);
        if (g) {
          const existing = this.#ops.get(e.id);
          if (existing && e.t === "erase") {
            const prior = g.erasures[existing.index];
            if (prior && prior.entry.t === "hd_advance") {
              prior.entry = e;
              prior.seq = seq;
            }
            return;
          }
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
            f.retained.push({
              reportedAt: e.at,
              receivedAt: e.received_at ?? e.at,
              detail: e.detail,
              until: e.retained?.until ?? null,
              basis: e.retained?.basis ?? null,
              scope: e.retained?.scope ?? null,
            });
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
