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
import { join } from "node:path";
import { HeldDataAuthority } from "../../lib/held-data/authority.ts";

export interface HeldDataRuntimeOptions {
  /** Directory of the authority journal. MUST be outside every backup-restore path. */
  journalDir?: string;
  /** Explicit journal file; overrides `journalDir`. */
  journalPath?: string;
  /** Restorable directory for the epoch marker (normally the main data directory). */
  markerDir?: string;
  now?: () => number;
  /** Shown to the owner once receipt is confirmed. Default 30 days. */
  deletionPeriodMs?: number;
  /** OD-4, the delivery-independent stop-use bound shown to the owner. Default 7 days. */
  pauseThresholdMs?: number;
}

export interface HeldDataRuntime {
  readonly authority: HeldDataAuthority;
  readonly now: () => number;
  readonly deletionPeriodMs: number;
  readonly pauseThresholdMs: number;
  /** Core stop-use bound (48 h): `stop_use_by` = effective time + this. */
  readonly stopUseBoundMs: number;
  close(): void;
}

let current: HeldDataRuntime | null = null;

export function getHeldDataRuntime(): HeldDataRuntime | null {
  return current;
}

export function installHeldDataRuntime(runtime: HeldDataRuntime | null): void {
  current = runtime;
}

export function createHeldDataRuntime(opts: HeldDataRuntimeOptions & { journalPath: string }): HeldDataRuntime {
  const now = opts.now ?? Date.now;
  const authority = HeldDataAuthority.open({
    journalPath: opts.journalPath,
    now,
    ...(opts.markerDir ? { epochMarkerPath: join(opts.markerDir, "held-data-authority-epoch") } : {}),
  });
  return {
    authority,
    now,
    deletionPeriodMs: opts.deletionPeriodMs ?? 30 * 24 * 60 * 60 * 1000,
    pauseThresholdMs: opts.pauseThresholdMs ?? 7 * 24 * 60 * 60 * 1000,
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
    ...(env.PDPP_HELD_DATA_MARKER_DIR ? { markerDir: env.PDPP_HELD_DATA_MARKER_DIR } : {}),
  };
}
