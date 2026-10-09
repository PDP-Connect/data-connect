// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime for the experimental AI-training processing permission and its
 * lease endpoint (draft AI Training Profile).
 *
 * OFF BY DEFAULT. Enabled only by `ServerOpts.experimentalAiTrainingLeases`
 * or `PDPP_EXPERIMENTAL_AI_TRAINING_LEASES=1` plus
 * `PDPP_TRAINING_AUTHORITY_DIR`. While no runtime is installed, every AS path
 * behaves exactly as before: a detail carrying `processing_permissions` is
 * rejected with `invalid_authorization_details` (Core's reserved-identifier
 * gate) and nothing is advertised.
 *
 * Like the rest of the AS (one global database handle), the runtime is
 * process-global: `startServer` installs it and `stop` removes it.
 *
 * PROTOTYPE: not for merge until the AI Training Profile is agreed.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { TrainingAuthorityStore } from "../../lib/training-lease/authority-store.ts";
import { AI_TRAINING_PERMISSION } from "../../lib/training-lease/constants.ts";
import { LeaseCredentialStore } from "../../lib/training-lease/credential-store.ts";

export { AI_TRAINING_PERMISSION };

export interface TrainingLeaseRuntimeOptions {
  /** Directory for the authority store file. */
  storeDir: string;
  /** Directory for the journal. MUST be outside every backup-restore path. */
  journalDir?: string;
  issuer: string;
  nodeId?: string;
  now?: () => number;
  /** Training `expires_at` = review time + this. Default 30 days. */
  trainingGrantLifetimeMs?: number;
  leaseLifetimeMs?: number;
  /** Lease endpoint requests per client per minute. */
  rateLimitPerMinute?: number;
}

export interface TrainingLeaseRuntime {
  readonly store: TrainingAuthorityStore;
  /** The shared authority journal (the held-data prototype appends to it too). */
  readonly journalPath: string;
  readonly credentials: LeaseCredentialStore;
  readonly now: () => number;
  readonly issuer: string;
  readonly trainingGrantLifetimeMs: number;
  readonly supportedPermissions: readonly string[];
  readonly rateLimitPerMinute: number;
  close(): void;
}

let current: TrainingLeaseRuntime | null = null;

export function getTrainingLeaseRuntime(): TrainingLeaseRuntime | null {
  return current;
}

export function installTrainingLeaseRuntime(
  runtime: TrainingLeaseRuntime | null,
): void {
  current = runtime;
}

export function createTrainingLeaseRuntime(
  opts: TrainingLeaseRuntimeOptions,
): TrainingLeaseRuntime {
  const now = opts.now ?? Date.now;
  const journalDir = opts.journalDir ?? opts.storeDir;
  const storePath = join(opts.storeDir, "training-authority.sqlite");
  const journalPath = join(journalDir, "training-authority.journal");
  const store = TrainingAuthorityStore.open({
    storePath,
    journalPath,
    issuer: opts.issuer,
    nodeId: opts.nodeId ?? `as-${randomBytes(4).toString("hex")}`,
    now,
    ...(opts.leaseLifetimeMs === undefined
      ? {}
      : { leaseLifetimeMs: opts.leaseLifetimeMs }),
  });
  const credentials = LeaseCredentialStore.open({ storePath, now });
  return {
    store,
    journalPath,
    credentials,
    now,
    issuer: opts.issuer,
    trainingGrantLifetimeMs:
      opts.trainingGrantLifetimeMs ?? 30 * 24 * 60 * 60 * 1000,
    supportedPermissions: [AI_TRAINING_PERMISSION],
    rateLimitPerMinute: opts.rateLimitPerMinute ?? 120,
    close() {
      credentials.close();
      store.close();
    },
  };
}

/** Env-driven enablement, mirroring the other `PDPP_*` toggles. Off unless both are set. */
export function trainingLeaseOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  issuer: string,
): TrainingLeaseRuntimeOptions | null {
  if (env.PDPP_EXPERIMENTAL_AI_TRAINING_LEASES !== "1") {
    return null;
  }
  const storeDir = env.PDPP_TRAINING_AUTHORITY_DIR;
  if (!storeDir) {
    throw new Error(
      "PDPP_EXPERIMENTAL_AI_TRAINING_LEASES=1 requires PDPP_TRAINING_AUTHORITY_DIR",
    );
  }
  return {
    issuer,
    storeDir,
    ...(env.PDPP_TRAINING_AUTHORITY_JOURNAL_DIR
      ? { journalDir: env.PDPP_TRAINING_AUTHORITY_JOURNAL_DIR }
      : {}),
  };
}

// ─── Core: closed issuance of processing_permissions ────────────────────────

export class ProcessingPermissionsError extends Error {
  /** Mapped to RFC 9396 `invalid_authorization_details` by the PAR and authorize adapters. */
  readonly code = "source.authorization_details_invalid";
}

/**
 * Remove `processing_permissions` from a raw detail and validate it (Core
 * "Closed issuance"). With no runtime, any non-empty value is unsupported.
 * Returns the detail without the member (so the closed contract schema still
 * validates everything else) and the permission set.
 */
export function extractProcessingPermissions(
  rawDetail: unknown,
  opts: { allow: boolean },
): { detail: unknown; permissions: string[] } {
  if (!rawDetail || typeof rawDetail !== "object" || Array.isArray(rawDetail)) {
    return { detail: rawDetail, permissions: [] };
  }
  const record = rawDetail as Record<string, unknown>;
  if (!Object.hasOwn(record, "processing_permissions")) {
    return { detail: rawDetail, permissions: [] };
  }
  const value = record.processing_permissions;
  const { processing_permissions: _removed, ...rest } = record;
  if (!Array.isArray(value)) {
    throw new ProcessingPermissionsError(
      "processing_permissions must be an array of absolute URIs",
    );
  }
  const seen = new Set<string>();
  for (const v of value) {
    if (
      typeof v !== "string" ||
      !URL.canParse(v) ||
      !/^[a-z][a-z0-9+.-]*:/i.test(v)
    ) {
      throw new ProcessingPermissionsError(
        "processing_permissions must contain absolute URIs",
      );
    }
    if (seen.has(v)) {
      throw new ProcessingPermissionsError(
        `processing_permissions contains a duplicate value: ${v}`,
      );
    }
    seen.add(v);
  }
  if (seen.size === 0) {
    return { detail: rest, permissions: [] };
  }
  const supported = opts.allow ? (current?.supportedPermissions ?? []) : [];
  for (const v of seen) {
    if (!supported.includes(v)) {
      throw new ProcessingPermissionsError(
        `processing_permissions contains an unsupported value: ${v}`,
      );
    }
  }
  if (
    seen.has(AI_TRAINING_PERMISSION) &&
    !(
      typeof rest.purpose_description === "string" &&
      rest.purpose_description.trim().length > 0
    )
  ) {
    throw new ProcessingPermissionsError(
      "an AI training detail requires a non-empty purpose_description",
    );
  }
  return { detail: rest, permissions: [...seen] };
}
