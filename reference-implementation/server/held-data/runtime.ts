// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime for the experimental held-data lifecycle prototype (integration-v2
 * K1–K4): owner dispositions, erasure operations, the grant-lifecycle status
 * operation and its restore-safe ordering.
 *
 * OFF BY DEFAULT. Enabled only by `ServerOpts.experimentalHeldDataLifecycle`
 * or `PDPP_EXPERIMENTAL_HELD_DATA_LIFECYCLE=1` plus
 * `PDPP_AUTHORITY_JOURNAL_DIR`. While no runtime is installed every AS path
 * behaves exactly as before.
 *
 * The journal must be the one the training-lease store uses (B3), so when
 * both prototypes run, the lease runtime's journal is used.
 *
 * PROTOTYPE: not for merge until the Core held-data text is final.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { HeldDataAuthority, type RestoreMechanism } from "../../lib/held-data/authority.ts";
import { RecoveryRequests } from "./recovery.ts";

export interface HeldDataRuntimeOptions {
  /** Directory of the authority journal. MUST be outside every backup-restore path. */
  journalDir?: string;
  /** Explicit journal file; overrides `journalDir`. */
  journalPath?: string;
  /** Restorable directory for the epoch marker (normally the main data directory). */
  markerDir?: string;
  /** Inbox outside the journal failure/restore domain; defaults to a sibling of the journal directory. */
  pendingActionDir?: string;
  /** Witness outside the inbox failure domain. Co-location detects file loss, not disk loss. */
  pendingEvidenceDir?: string;
  /**
   * The restore mechanism this deployment declares (Core: Lifecycle durability).
   * `outside_witness` (default): loss-detection evidence and a pending inbox outside the history.
   * `invalidate_on_restore`: one store and no outside witness. Restore it only through
   * `HeldDataAuthority.restoreFromSnapshot`; any other rollback goes undetected, and the owner
   * statement says so.
   */
  restoreMechanism?: RestoreMechanism;
  now?: () => number;
  /** Shown to the owner once receipt is confirmed. Default 30 days. */
  deletionPeriodMs?: number;
  /** Expiry of a lifecycle recovery token for lifecycle writes. Default 24 hours. */
  recoveryTokenTtlMs?: number;
}

export interface HeldDataRuntime {
  readonly authority: HeldDataAuthority;
  readonly now: () => number;
  readonly deletionPeriodMs: number;
  readonly recoveryTokenTtlMs: number;
  /** Pending lifecycle recovery requests and codes (server/held-data/recovery.ts). */
  readonly recovery: RecoveryRequests;
  /** Core stop-use bound (48 h): `stop_use_by` = effective time + this. */
  readonly stopUseBoundMs: number;
  close(): void;
}

let current: HeldDataRuntime | null = null;
const clientAssertions = new WeakMap<HeldDataRuntime, Map<string, number>>();

/** Consume a verified assertion once across the lifecycle and revocation endpoints. */
export function acceptHeldDataClientAssertion(
  runtime: HeldDataRuntime,
  clientId: string,
  claims: Record<string, unknown>
): boolean {
  const { jti, exp } = claims;
  const now = runtime.now();
  if (
    typeof jti !== "string" ||
    jti.length === 0 ||
    typeof exp !== "number" ||
    !Number.isFinite(exp) ||
    exp * 1000 <= now
  ) {
    return false;
  }
  const seen = clientAssertions.get(runtime) ?? new Map<string, number>();
  clientAssertions.set(runtime, seen);
  for (const [key, until] of seen) {
    if (until <= now) {
      seen.delete(key);
    }
  }
  const key = JSON.stringify([clientId, jti]);
  if (seen.has(key)) {
    return false;
  }
  seen.set(key, exp * 1000);
  return true;
}

export function getHeldDataRuntime(): HeldDataRuntime | null {
  return current;
}

export function installHeldDataRuntime(runtime: HeldDataRuntime | null): void {
  current = runtime;
}

export function createHeldDataRuntime(opts: HeldDataRuntimeOptions & { journalPath: string }): HeldDataRuntime {
  const now = opts.now ?? Date.now;
  const witnessed = opts.restoreMechanism !== "invalidate_on_restore";
  const markerDir = witnessed ? opts.markerDir : undefined;
  const pendingDir = opts.pendingActionDir ?? `${dirname(opts.journalPath)}-pending`;
  const pendingEvidenceDir = witnessed ? (opts.pendingEvidenceDir ?? markerDir) : undefined;
  if (pendingEvidenceDir) mkdirSync(pendingDir, { recursive: true });
  if (pendingEvidenceDir) mkdirSync(pendingEvidenceDir, { recursive: true });
  const authority = HeldDataAuthority.open({
    journalPath: opts.journalPath,
    now,
    ...(pendingEvidenceDir
      ? {
          pendingPath: join(pendingDir, "held-data-pending-actions"),
          pendingEvidencePath: join(pendingEvidenceDir, "held-data-pending-evidence"),
        }
      : {}),
    ...(markerDir ? { epochMarkerPath: join(markerDir, "held-data-authority-epoch") } : {}),
  });
  return {
    authority,
    now,
    deletionPeriodMs: opts.deletionPeriodMs ?? 30 * 24 * 60 * 60 * 1000,
    recoveryTokenTtlMs: opts.recoveryTokenTtlMs ?? 24 * 60 * 60 * 1000,
    recovery: new RecoveryRequests(),
    stopUseBoundMs: 48 * 60 * 60 * 1000,
    close() {
      // The authority holds no open handles.
    },
  };
}

/** Env-driven enablement. Off unless both are set. */
export function heldDataOptionsFromEnv(env: NodeJS.ProcessEnv): HeldDataRuntimeOptions | null {
  if (env.PDPP_EXPERIMENTAL_HELD_DATA_LIFECYCLE !== "1") {
    return null;
  }
  const journalDir = env.PDPP_AUTHORITY_JOURNAL_DIR;
  if (!journalDir) {
    throw new Error("PDPP_EXPERIMENTAL_HELD_DATA_LIFECYCLE=1 requires PDPP_AUTHORITY_JOURNAL_DIR");
  }
  return {
    journalDir,
    ...(env.PDPP_HELD_DATA_PENDING_DIR ? { pendingActionDir: env.PDPP_HELD_DATA_PENDING_DIR } : {}),
    ...(env.PDPP_HELD_DATA_PENDING_EVIDENCE_DIR ? { pendingEvidenceDir: env.PDPP_HELD_DATA_PENDING_EVIDENCE_DIR } : {}),
    ...(env.PDPP_HELD_DATA_MARKER_DIR ? { markerDir: env.PDPP_HELD_DATA_MARKER_DIR } : {}),
    ...(env.PDPP_HELD_DATA_RESTORE_MECHANISM === "invalidate_on_restore"
      ? { restoreMechanism: "invalidate_on_restore" as const }
      : {}),
  };
}
