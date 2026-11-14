// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { Handle, Observation } from "@tnunamak/gozar";

export const phases = [
  "inactive",
  "draft",
  "setup",
  "review",
  "applying",
  "detected",
  "checking",
  "verified",
  "stale",
  "unknown",
  "failed",
  "reconciling",
  "lost",
  "stopping",
  "stopped",
] as const;
export type Phase = (typeof phases)[number];
export const events = [
  "restore-intent",
  "recovered-handle",
  "choose",
  "setup",
  "setup-complete",
  "setup-failed",
  "setup-timeout",
  "review",
  "apply",
  "allocated",
  "start-failed",
  "start-timeout",
  "check",
  "proof-passed",
  "proof-failed",
  "proof-expired",
  "proof-refresh-unsupported",
  "approval-changed",
  "approval-expired",
  "restart",
  "restart-failed",
  "restart-timeout",
  "reconcile",
  "agent-exit",
  "stop",
  "host-confinement",
  "cleanup-unconfirmed",
  "cleanup-confirmed",
] as const;
export type EventName = (typeof events)[number];
export type Lifecycle = {
  phase: Phase;
  handle: Handle | null;
  operationId: string | null;
  epoch: number;
  approvalIdentity: string | null;
  stopTombstone: boolean;
  evidence: "unknown" | "detected" | "checking" | "verified" | "stale" | "failed";
  confinement: Observation<boolean>;
  cleanup: "none" | "unconfirmed" | "confirmed";
  reason: string | null;
};
export type LifecycleEvent = {
  type: EventName;
  handle?: Handle;
  operationId?: string;
  epoch?: number;
  approvalIdentity?: string;
  approvalExpiresAt?: number;
  now?: number;
  observed?: "present" | "absent" | "failed";
  confinement?: Observation<boolean>;
};
export type Effect =
  | "withdraw-publication"
  | "observe-route"
  | "close-route"
  | "recover-operation"
  | "require-review"
  | "start-route";
export type Transition =
  | { accepted: true; state: Lifecycle; effects: Effect[] }
  | { accepted: false; reason: string; state: Lifecycle; effects: [] };
type Rule = (state: Lifecycle, event: LifecycleEvent) => Transition;
const accept = (state: Lifecycle, update: Partial<Lifecycle>, effects: Effect[] = []): Transition => ({
  accepted: true,
  effects,
  state: { ...state, ...update },
});
const reject = (state: Lifecycle, reason = "transition-rejected"): Transition => ({
  accepted: false,
  effects: [],
  reason,
  state,
});
const to =
  (phase: Phase, update: Partial<Lifecycle> = {}, effects: Effect[] = []): Rule =>
  (state) =>
    accept(state, { phase, ...update }, effects);

// Null is an explicit rejection, including events that a phase cannot receive.
// All permitted phase changes are declared here; effects do not change phases.
export const transitionTable = Object.fromEntries(
  phases.map((phase) => [phase, Object.fromEntries(events.map((event) => [event, null]))])
) as Record<Phase, Record<EventName, Rule | null>>;
function allow(states: readonly Phase[], event: EventName, rule: Rule): void {
  for (const state of states) {
    transitionTable[state][event] = rule;
  }
}
const retained = phases.filter((phase) => phase !== "inactive" && phase !== "stopped");
allow(["inactive", "unknown", "failed", "reconciling"], "restore-intent", (state, event) =>
  accept(state, {
    evidence: "unknown",
    handle: event.handle ?? null,
    operationId: event.operationId ?? state.operationId,
    phase: "reconciling",
  })
);
allow(phases, "recovered-handle", (state, event) =>
  event.handle ? accept(state, { handle: event.handle }) : reject(state, "handle-missing")
);
allow(phases, "choose", (state) =>
  state.handle && !state.stopTombstone ? accept(state, {}) : accept(state, { phase: "draft" })
);
allow(phases, "setup", (state) => (state.handle ? accept(state, {}) : accept(state, { phase: "setup" })));
allow(phases, "setup-complete", (state) => (state.handle ? accept(state, {}) : accept(state, { phase: "draft" })));
for (const event of ["setup-failed", "setup-timeout"] as const) {
  allow(["setup"], event, to("failed", { reason: event }));
}
allow(["draft", "setup", "review", "stale", "unknown", "failed", "stopped"], "review", (state, event) =>
  event.approvalIdentity
    ? accept(state, { approvalIdentity: event.approvalIdentity, phase: "review", reason: null })
    : reject(state, "approval-identity-missing")
);
allow(["review"], "apply", (state, event) => {
  if (
    !event.approvalIdentity ||
    event.approvalIdentity !== state.approvalIdentity ||
    event.approvalExpiresAt === undefined ||
    event.now === undefined ||
    !Number.isFinite(event.approvalExpiresAt) ||
    event.approvalExpiresAt <= event.now
  ) {
    return accept(state, { approvalIdentity: null, phase: "review", reason: "fresh-review-required" }, [
      "require-review",
    ]);
  }
  return accept(
    state,
    {
      epoch: state.epoch + 1,
      evidence: "unknown",
      handle: null,
      operationId: event.operationId ?? null,
      phase: "applying",
      stopTombstone: false,
    },
    ["start-route"]
  );
});
allow(["applying"], "allocated", (state, event) =>
  event.handle
    ? accept(state, { evidence: "detected", handle: event.handle, phase: "detected" })
    : reject(state, "handle-missing")
);
for (const event of ["start-failed", "start-timeout"] as const) {
  allow(["applying", "detected"], event, (state) =>
    accept(
      state,
      { evidence: "failed", phase: state.handle || state.operationId ? "unknown" : "failed", reason: event },
      ["withdraw-publication"]
    )
  );
}
// R1: recheck failure changes evidence only. It never requests close-route.
allow(["detected", "checking", "verified", "stale", "unknown", "failed", "reconciling"], "check", (state) =>
  state.handle && !state.stopTombstone
    ? accept(state, { evidence: "checking", phase: "checking" }, ["observe-route"])
    : reject(state, "handle-missing")
);
allow(["checking", "detected"], "proof-passed", (state, event) => {
  if (state.stopTombstone || event.epoch !== state.epoch || !state.handle) {
    return reject(state, "proof-superseded");
  }
  return accept(state, { evidence: "verified", phase: "verified", reason: null });
});
allow(["checking"], "proof-failed", to("failed", { evidence: "failed" }, ["withdraw-publication"]));
allow(["verified"], "proof-expired", to("stale", { evidence: "stale" }, ["withdraw-publication"]));
allow(
  retained,
  "proof-refresh-unsupported",
  to("unknown", { evidence: "unknown", reason: "proof_refresh_unsupported" }, ["withdraw-publication"])
);
for (const event of ["approval-changed", "approval-expired"] as const) {
  allow(
    retained,
    event,
    to("review", { approvalIdentity: null, evidence: "stale", reason: "fresh-review-required" }, [
      "withdraw-publication",
      "require-review",
    ])
  );
}
allow(retained, "restart", (state) =>
  accept(state, { epoch: state.epoch + 1, evidence: "unknown", phase: "reconciling" }, ["withdraw-publication"])
);
for (const event of ["restart-failed", "restart-timeout"] as const) {
  allow(["reconciling"], event, to("unknown", { evidence: "unknown", reason: event }, ["withdraw-publication"]));
}
allow(["reconciling", "unknown"], "reconcile", (state, event) => {
  // R2: tombstone is tested before any observation/proof branch.
  if (state.stopTombstone) {
    return accept(
      state,
      { evidence: "unknown", phase: "stopping" },
      state.handle ? ["withdraw-publication", "close-route"] : ["withdraw-publication", "recover-operation"]
    );
  }
  if (!state.handle && state.operationId) {
    return accept(state, { evidence: "unknown", phase: "unknown", reason: "unknown-possibly-live" }, [
      "recover-operation",
    ]);
  }
  if (event.observed === "failed") {
    return accept(state, { evidence: "unknown", phase: "unknown", reason: "observation-failed" });
  }
  if (event.observed === "absent") {
    return accept(state, { evidence: "unknown", phase: "unknown", reason: "route-absent" });
  }
  if (event.observed === "present" && state.handle) {
    return accept(state, { evidence: "checking", phase: "checking" }, ["observe-route"]);
  }
  return reject(state, "observation-missing");
});
allow(phases, "agent-exit", (state) =>
  state.handle
    ? accept(state, { epoch: state.epoch + 1, evidence: "unknown", phase: "stopping", reason: "agent-exited" }, [
        "withdraw-publication",
        "close-route",
      ])
    : reject(state, "handle-missing")
);
allow(phases, "stop", (state) =>
  accept(
    state,
    { epoch: state.epoch + 1, evidence: "unknown", phase: "stopping", stopTombstone: true },
    state.handle ? ["withdraw-publication", "close-route"] : ["withdraw-publication", "recover-operation"]
  )
);
allow(phases, "host-confinement", (state, event) =>
  event.confinement
    ? accept(state, { confinement: event.confinement })
    : reject(state, "confinement-observation-missing")
);
allow(["stopping", "stopped", "unknown"], "cleanup-unconfirmed", to("stopping", { cleanup: "unconfirmed" }));
allow(["stopping", "stopped", "unknown"], "cleanup-confirmed", (state) =>
  accept(state, {
    cleanup: "confirmed",
    phase: state.confinement.known && state.confinement.value ? "stopped" : "unknown",
  })
);

export function initialLifecycle(): Lifecycle {
  return {
    approvalIdentity: null,
    cleanup: "none",
    confinement: { known: false, reason: "not-observed" },
    epoch: 0,
    evidence: "unknown",
    handle: null,
    operationId: null,
    phase: "inactive",
    reason: null,
    stopTombstone: false,
  };
}
export function reduceLifecycle(state: Lifecycle, event: LifecycleEvent): Transition {
  const rule = transitionTable[state.phase][event.type];
  return rule ? rule(state, event) : reject(state);
}
export function lifecycleLabel(state: Lifecycle): string {
  if (state.confinement.known && state.confinement.value && state.stopTombstone) {
    return "Stopped locally";
  }
  if (state.reason === "unknown-possibly-live") {
    return "Unknown, possibly live";
  }
  return state.phase;
}
