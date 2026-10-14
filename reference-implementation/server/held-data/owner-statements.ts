// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the owner is told about held data (Core: Erasure, "AS records and
 * owner statements"; Lifecycle durability). Pure functions of recorded facts,
 * so the wording can be tested without a server.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import type { RetainedUntil } from "../../lib/held-data/authority.ts";

/** Section 10: read-access revocation propagates within the introspection cache bound. */
export const READ_PROPAGATION_SECONDS = 60;

const at = (ms: number): string => new Date(ms).toISOString();

/** A retained report's end, in the form the client gave (never an invented date). */
export function formatRetainedUntil(until: RetainedUntil | null): string {
  if (until === null) return "end not stated";
  if (until.form === "date-time") return `ends ${at(until.at)}`;
  if (until.form === "event") return `ends at an event or condition: ${until.text}`;
  return "end unknown";
}

/** How long the app may keep using the data, as the owner reads it. */
export function retentionCeilingText(maxDuration: string | null): string {
  return maxDuration
    ? `until each record's retention ceiling (the app's first acquisition of the record plus ${maxDuration})`
    : "with no time limit, because the grant states no retention limit";
}

export interface ErasureFacts {
  accepted_at: number;
  effective_at: number | null;
  delivered_at: number | null;
  receipt_at: number | null;
  completion: { at: number; outcome: string } | null;
  retained: { reportedAt: number; receivedAt: number; until: RetainedUntil | null }[];
}

export type Stage = "requested" | "sent" | "receipt_reported" | "completed" | "exception_reported";

/** The stages the AS has recorded, and the latest one. A retained report is an exception, never completion. */
export function stagesOf(e: ErasureFacts) {
  const recorded: Stage[] = ["requested"];
  if (e.delivered_at !== null) recorded.push("sent");
  if (e.receipt_at !== null) recorded.push("receipt_reported");
  if (e.retained.length > 0) recorded.push("exception_reported");
  if (e.completion) recorded.push("completed");
  return {
    requested_at: at(e.accepted_at),
    sent_at: e.delivered_at === null ? null : at(e.delivered_at),
    receipt_reported_at: e.receipt_at === null ? null : at(e.receipt_at),
    exception_reported_at: e.retained.length > 0 ? at(e.retained[e.retained.length - 1]!.receivedAt) : null,
    completion_reported_at: e.completion ? at(e.completion.at) : null,
    latest: recorded[recorded.length - 1] as Stage,
  };
}

/**
 * The statements the AS makes when the owner chooses `delete`. The deletion
 * date appears only once a receipt is reported; the AS never computes one from
 * acceptance or first return.
 */
export function erasureStatements(input: {
  effectiveAt: number | null;
  stopUseBoundMs: number;
  deletionPeriodMs: number;
  retentionMaxDuration: string | null;
}): string[] {
  const days = Math.round(input.deletionPeriodMs / 86_400_000);
  const stopUse =
    input.effectiveAt === null
      ? "48 hours after the grant ends, which is when this advance election takes effect"
      : at(input.effectiveAt + input.stopUseBoundMs);
  return [
    "Scope: all data the app holds under this grant, including derivatives, copies held by parties acting for the app, and backups.",
    "Exceptions: parameters learned under valid processing authority before it ended, data made non-identifiable before the effective time, copies the app acquired independently under another grant, and data the law requires the app to keep.",
    `The app must stop using covered data as soon as practicable after it receives this request: by ${stopUse} if it receives it by then, and at once if it receives it later. It must delete covered data within ${days} days of receiving the request.`,
    "The app learns of this request only when it gets an answer from your server. While the app runs, it tries daily to check with your server, but a try is not a received request. An app that is not running does not check, and learns of this request only when it next runs and checks.",
    "If your server is offline, the app cannot learn of the request until your server answers, and there is no maximum delay.",
    `If your server never answers again before the app receives the request, the app may keep using the data for the approved purpose ${retentionCeilingText(input.retentionMaxDuration)}.`,
    "If the app offers deletion, deleting inside it binds the app at once. That is an instruction, not instant physical deletion. These are duties of conforming apps, not proof of remote deletion. Legally required copies and the stated exclusions may remain.",
  ];
}

/** The stage line for one instruction. No deletion date until a receipt is reported. */
export function stageLine(e: ErasureFacts, deleteBy: number | null): string {
  const s = stagesOf(e);
  if (s.latest === "completed") return `Completion reported on ${s.completion_reported_at}.`;
  if (s.latest === "exception_reported") {
    const last = e.retained[e.retained.length - 1]!;
    return `The app reported that it deleted this data except data the law requires it to keep (${formatRetainedUntil(last.until)}). That data is not reported as deleted.`;
  }
  if (s.latest === "receipt_reported") return `Receipt reported on ${s.receipt_reported_at}. Deletion is due by ${at(deleteBy as number)}.`;
  if (s.latest === "sent") return `Sent on ${s.sent_at}; no receipt reported. No deletion date applies yet.`;
  return `Requested on ${s.requested_at}; not yet sent. No deletion date applies yet.`;
}

/** Shown while the history is unavailable (Core: Lifecycle durability, owner actions while unavailable). */
export const PENDING_HISTORY_STATEMENT =
  `Action recorded and pending. Until history is re-established, the server issues no tokens or processing authority and returns no positive assessments for the affected grants. Read access ends within ${READ_PROPAGATION_SECONDS} seconds (the bounded propagation period); a cached introspection result can permit reads only within its original cache lifetime and applicable read deadline.`;

/** Shown while a restore left a grant not current (mechanism: invalidation on restore). */
export const RESTORED_STATEMENT =
  `This grant's history was restored and is not yet re-established. Any action you take is recorded now and applied before any answer. Until then the server issues no tokens or processing authority and returns no positive assessments for it. Read access ends within ${READ_PROPAGATION_SECONDS} seconds (the bounded propagation period); a cached introspection result can permit reads only within its original cache lifetime and applicable read deadline.`;

/** Before the AS stops answering for good: what the owner must know about undelivered deletes. */
export function decommissionStatement(): string {
  return "Once this server stops answering for good, an app that has not yet received a delete request cannot learn of it. Such an app may keep and use the data, as the grant permits, until the grant's retention ceiling, or with no time limit when the grant states none. Each disposition below shows its stage: offered, recorded, sent, or receipt reported. A delete that no app has received yet is marked.";
}
