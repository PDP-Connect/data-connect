// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-run gate cascade for the scheduler.
 *
 * Encapsulates the pre-launch gate sequence that `executeRun` runs before
 * dispatching a connector. The cascade order is the invariant:
 *   durable attention → automation policy → readiness → needs-human → grant state.
 *
 * Extracted from `createScheduler` in scheduler.ts as a narrow factory so
 * the gate logic can be read and tested without owning the full scheduler closure.
 *
 * Every gate DECIDES; none of them emits. A gate that ends the dispatch with a
 * recorded skip returns the skip as a `commit` (see `GateDecision`), and the
 * scheduler runs it only after confirming the dispatch is still valid. A gate
 * that is dropped therefore leaves no record, no dedup mark and no escalation.
 */

import { createEscalationLedger, type EscalationLedger } from "./escalation-ledger.ts";
import { type AutomationRefreshPolicy, projectRunAutomationPolicy } from "../run-automation-policy.ts";
import type {
  ConnectorSchedule,
  DispatchEscalationHandler,
  GrantAccessMode,
  HasUnresolvedAttentionHandler,
  IsNeedsHumanHandler,
  RunRecord,
  RunSource,
  SchedulerManifest,
  SchedulerReadinessChecker,
  TerminalGrantFailureReason,
  UnresolvedAttentionEvidence,
} from "../scheduler-domain-types.ts";

// ─── Dep types ───────────────────────────────────────────────────────────────

/**
 * Runtime state cells the gate functions read and mutate.
 * Passed by reference so mutations take effect in the shared runtime.
 */
export interface PreRunGateRuntimeState {
  readonly disabledGrantFailures: Map<string, TerminalGrantFailureReason>;
  readonly exhaustedGrants: Set<string>;
  readonly notifiedAttentionSkips: Map<string, string>;
  readonly notifiedDisabledGrantFailures: Set<string>;
  readonly notifiedNeedsHumanSkips: Set<string>;
  readonly notifiedNotReadySkips: Map<string, string>;
}

export interface PreRunGateDeps {
  /** Delivery state of the escalations raised here; defaults to a private ledger. */
  escalationLedger?: EscalationLedger;
  hasUnresolvedAttention: HasUnresolvedAttentionHandler;
  isNeedsHuman: IsNeedsHumanHandler;
  onHumanRequiredStateEscalation: DispatchEscalationHandler;
  readinessChecker: SchedulerReadinessChecker;
  recordAndNotify: (record: RunRecord) => RunRecord;
  runtime: PreRunGateRuntimeState;
}

// ─── Gate decision type ──────────────────────────────────────────────────────

/**
 * What a pre-run gate decided, with its effects held back.
 *
 *   - `proceed`: the gate is clear; the next gate runs.
 *   - `silent`: the dispatch ends with no record (this skip was already announced).
 *   - `skip`: the dispatch ends with a recorded skip. Announcing it is a side
 *     effect of the dispatch, so nothing has happened yet: `commit()` marks the
 *     announce-once state, raises the escalation, if any, and records the skip.
 *     The caller runs it exactly once, and only after the dispatch is confirmed
 *     still valid (scheduler not stopped, schedule still enabled). A decision
 *     that is dropped leaves no trace, so the next valid tick decides afresh.
 *
 * Resets of announce-once state that mirror what the gate observed (attention
 * resolved, readiness restored, needs-human cleared) are held back too. They ride
 * on the decision's optional `commit`, which the caller runs, once, only while
 * the dispatch is valid: an abandoned evaluation (one that outlived the liveness
 * ceiling) is never committed, so its stale observation cannot reset the state a
 * newer evaluation has since committed. `silent` and `proceed` commits record
 * nothing; a `silent` commit may also re-raise an escalation that was dropped.
 */
export type GateDecision =
  | { readonly commit?: () => void; readonly kind: "proceed" }
  | { readonly commit?: () => void; readonly kind: "silent" }
  | { readonly commit: () => RunRecord; readonly kind: "skip" };

/** A decision that ends the dispatch: everything but `proceed`. */
export type EndingGateDecision = Exclude<GateDecision, { readonly kind: "proceed" }>;

const PROCEED: GateDecision = Object.freeze({ kind: "proceed" });

function proceedWith(commit: () => void): GateDecision {
  return { commit, kind: "proceed" };
}
const SILENT: GateDecision = Object.freeze({ kind: "silent" });

function skipWith(commit: () => RunRecord): GateDecision {
  return { commit, kind: "skip" };
}

// ─── Local helpers (mirrored from scheduler.ts; kept in sync by extraction) ──

function buildScheduledRunSource(connectorId: string): RunSource {
  return { id: connectorId, kind: "connector" };
}

function runtimeKey(schedule: Pick<ConnectorSchedule, "connectorId" | "connectorInstanceId">): string {
  return schedule.connectorInstanceId || schedule.connectorId;
}

function getManifestRefreshPolicy(manifest: SchedulerManifest | null | undefined): AutomationRefreshPolicy | null {
  const capabilities =
    manifest && typeof manifest === "object" ? (manifest as { capabilities?: unknown }).capabilities : null;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }
  const policy = (capabilities as { refresh_policy?: unknown }).refresh_policy;
  return policy && typeof policy === "object" && !Array.isArray(policy) ? (policy as AutomationRefreshPolicy) : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildSingleUseExhaustedSkip(connectorId: string, connectorInstanceId?: string): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: "single_use grant already consumed",
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildDisabledGrantSkip(
  connectorId: string,
  terminalReason: TerminalGrantFailureReason,
  connectorInstanceId?: string
): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `${terminalReason} grant no longer usable`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
    terminalReason,
  };
}

function buildUnresolvedAttentionSkip(
  connectorId: string,
  evidence: UnresolvedAttentionEvidence,
  connectorInstanceId?: string
): RunRecord {
  const tail = evidence.reason ? `: ${evidence.reason} (${evidence.key})` : `: ${evidence.key}`;
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `attention_unresolved${tail}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildNeedsHumanSkip(connectorId: string, connectorInstanceId?: string): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: "needs_human_attention: automatic run skipped until owner provides input",
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildNotReadySkip(connectorId: string, reason: string, connectorInstanceId?: string): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `not_ready: ${reason}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildAutomationPolicySkip(
  connectorId: string,
  reason: string | null,
  connectorInstanceId?: string
): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `automation_policy_blocked: ${reason || "automatic run is not allowed by connector policy"}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface PreRunGate {
  decideDisabledGrant: (connectorId: string, connectorInstanceId: string) => GateDecision;
  decideNotReady: (schedule: ConnectorSchedule) => Promise<GateDecision>;
  gateAttention: (connectorId: string, connectorInstanceId: string, key: string) => Promise<GateDecision>;
  gateAutomationPolicy: (
    connectorId: string,
    connectorInstanceId: string,
    key: string,
    policy: ReturnType<typeof projectRunAutomationPolicy>
  ) => GateDecision;
  gateGrantState: (
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: NonNullable<ConnectorSchedule["grantAccessMode"]>
  ) => GateDecision;
  gateNeedsHuman: (
    connectorId: string,
    connectorInstanceId: string,
    key: string,
    signal?: AbortSignal
  ) => GateDecision;
  maybeSkipSingleUseExhausted: (
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: GrantAccessMode
  ) => GateDecision;
  probeUnresolvedAttention: (
    connectorId: string,
    connectorInstanceId: string
  ) => Promise<UnresolvedAttentionEvidence | null>;
  /**
   * `signal` is the epoch signal of the automatic dispatch running the cascade.
   * The escalation a committed needs-human skip raises is bound to it. Without
   * one the scheduler drops the escalation: nothing identifies the dispatch.
   */
  runAutomaticPreflight: (
    schedule: ConnectorSchedule,
    key: string,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>,
    signal?: AbortSignal
  ) => Promise<GateDecision>;
}

export function createPreRunGate(deps: PreRunGateDeps): PreRunGate {
  const {
    escalationLedger: ledger = createEscalationLedger(),
    hasUnresolvedAttention,
    isNeedsHuman,
    onHumanRequiredStateEscalation,
    readinessChecker,
    runtime,
    recordAndNotify,
  } = deps;

  async function probeUnresolvedAttention(
    connectorId: string,
    connectorInstanceId: string
  ): Promise<UnresolvedAttentionEvidence | null> {
    try {
      const observed = await hasUnresolvedAttention(connectorId, connectorInstanceId);
      return observed ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] attention probe failed for ${connectorId}: ${message}`);
      return null;
    }
  }

  function maybeSkipSingleUseExhausted(
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: GrantAccessMode
  ): GateDecision {
    if (grantAccessMode !== "single_use" || !runtime.exhaustedGrants.has(connectorInstanceId)) {
      return PROCEED;
    }
    return skipWith(() => recordAndNotify(buildSingleUseExhaustedSkip(connectorId, connectorInstanceId)));
  }

  async function decideNotReady(schedule: ConnectorSchedule): Promise<GateDecision> {
    const readiness = await readinessChecker(schedule);
    const key = runtimeKey(schedule);
    if (!readiness || readiness.ready) {
      return runtime.notifiedNotReadySkips.has(key)
        ? proceedWith(() => {
            runtime.notifiedNotReadySkips.delete(key);
          })
        : PROCEED;
    }
    const projection = projectRunAutomationPolicy({
      deploymentReadiness: {
        ready: false,
        reason: readiness.reason || "scheduled connector runtime prerequisites are not currently satisfied",
      },
      refreshPolicy: getManifestRefreshPolicy(schedule.manifest),
      triggerKind: "scheduled",
    });
    const reason = projection.reason || "scheduled connector runtime prerequisites are not currently satisfied";
    if (runtime.notifiedNotReadySkips.get(key) === reason) {
      return SILENT;
    }
    return skipWith(() => {
      runtime.notifiedNotReadySkips.set(key, reason);
      return recordAndNotify(buildNotReadySkip(schedule.connectorId, reason, schedule.connectorInstanceId));
    });
  }

  function decideDisabledGrant(connectorId: string, connectorInstanceId: string): GateDecision {
    if (!runtime.disabledGrantFailures.has(connectorInstanceId)) {
      return PROCEED;
    }
    if (runtime.notifiedDisabledGrantFailures.has(connectorInstanceId)) {
      return SILENT;
    }
    const terminalReason = runtime.disabledGrantFailures.get(connectorInstanceId);
    if (!terminalReason) {
      return PROCEED;
    }
    return skipWith(() => {
      runtime.notifiedDisabledGrantFailures.add(connectorInstanceId);
      return recordAndNotify(buildDisabledGrantSkip(connectorId, terminalReason, connectorInstanceId));
    });
  }

  async function gateAttention(connectorId: string, connectorInstanceId: string, key: string): Promise<GateDecision> {
    const attentionEvidence = await probeUnresolvedAttention(connectorId, connectorInstanceId);
    if (!attentionEvidence?.key) {
      return runtime.notifiedAttentionSkips.has(key)
        ? proceedWith(() => {
            runtime.notifiedAttentionSkips.delete(key);
          })
        : PROCEED;
    }
    const attentionKey = attentionEvidence.key;
    if (runtime.notifiedAttentionSkips.get(key) === attentionKey) {
      return SILENT;
    }
    return skipWith(() => {
      runtime.notifiedAttentionSkips.set(key, attentionKey);
      return recordAndNotify(buildUnresolvedAttentionSkip(connectorId, attentionEvidence, connectorInstanceId));
    });
  }

  function gateAutomationPolicy(
    connectorId: string,
    connectorInstanceId: string,
    key: string,
    policy: ReturnType<typeof projectRunAutomationPolicy>
  ): GateDecision {
    if (policy.allowed_to_start) {
      return PROCEED;
    }
    const reason = policy.reason || "automatic run is not allowed by connector policy";
    const dedupeReason = `automation_policy_blocked:${reason}`;
    if (runtime.notifiedNotReadySkips.get(key) === dedupeReason) {
      return SILENT;
    }
    return skipWith(() => {
      runtime.notifiedNotReadySkips.set(key, dedupeReason);
      return recordAndNotify(buildAutomationPolicySkip(connectorId, reason, connectorInstanceId));
    });
  }

  function gateNeedsHuman(
    connectorId: string,
    connectorInstanceId: string,
    key: string,
    signal?: AbortSignal
  ): GateDecision {
    const info = { connectorId, connectorInstanceId, reason: "needs_attention" } as const;
    if (!isNeedsHuman(connectorId, connectorInstanceId)) {
      return runtime.notifiedNeedsHumanSkips.has(key) || ledger.isUndelivered(info.reason, connectorInstanceId)
        ? proceedWith(() => {
            runtime.notifiedNeedsHumanSkips.delete(key);
            ledger.clear(info.reason, connectorInstanceId);
          })
        : PROCEED;
    }
    if (runtime.notifiedNeedsHumanSkips.has(key)) {
      // The skip was recorded already. If its push was dropped, raise it again.
      return ledger.isUndelivered(info.reason, connectorInstanceId)
        ? { commit: () => ledger.raise(onHumanRequiredStateEscalation, info, signal), kind: "silent" }
        : SILENT;
    }
    return skipWith(() => {
      runtime.notifiedNeedsHumanSkips.add(key);
      ledger.raise(onHumanRequiredStateEscalation, info, signal);
      return recordAndNotify(buildNeedsHumanSkip(connectorId, connectorInstanceId));
    });
  }

  async function runAutomaticPreflight(
    schedule: ConnectorSchedule,
    key: string,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>,
    signal?: AbortSignal
  ): Promise<GateDecision> {
    const { connectorId, connectorInstanceId = connectorId } = schedule;

    // Resets from the stages that cleared ride on whichever decision ends the
    // cascade, so they are committed (or abandoned) together with it.
    const resets: Array<() => void> = [];
    const settle = (decision: GateDecision): GateDecision => {
      if (resets.length === 0) {
        return decision;
      }
      const runResets = (): void => {
        for (const reset of resets) {
          reset();
        }
      };
      if (decision.kind === "skip") {
        const { commit } = decision;
        return skipWith(() => {
          runResets();
          return commit();
        });
      }
      const { commit } = decision;
      const combined = (): void => {
        runResets();
        commit?.();
      };
      return decision.kind === "silent" ? { commit: combined, kind: "silent" } : proceedWith(combined);
    };
    const stage = (decision: GateDecision): GateDecision | null => {
      if (decision.kind === "proceed") {
        if (decision.commit) {
          resets.push(decision.commit);
        }
        return null;
      }
      return settle(decision);
    };

    const ended =
      stage(await gateAttention(connectorId, connectorInstanceId, key)) ??
      stage(gateAutomationPolicy(connectorId, connectorInstanceId, key, automationPolicy)) ??
      stage(await decideNotReady(schedule)) ??
      stage(gateNeedsHuman(connectorId, connectorInstanceId, key, signal));
    return ended ?? settle(PROCEED);
  }

  function gateGrantState(
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: NonNullable<ConnectorSchedule["grantAccessMode"]>
  ): GateDecision {
    const singleUseDecision = maybeSkipSingleUseExhausted(connectorId, connectorInstanceId, grantAccessMode);
    if (singleUseDecision.kind !== "proceed") {
      return singleUseDecision;
    }
    return decideDisabledGrant(connectorId, connectorInstanceId);
  }

  return {
    decideDisabledGrant,
    decideNotReady,
    gateAttention,
    gateAutomationPolicy,
    gateGrantState,
    gateNeedsHuman,
    maybeSkipSingleUseExhausted,
    probeUnresolvedAttention,
    runAutomaticPreflight,
  };
}
