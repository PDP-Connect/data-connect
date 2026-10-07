// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RunHandleStatus, TimelineEnvelope } from "../../../lib/ref-client.ts";

export type NoAssistanceEndedStatus = "failed" | "cancelled" | "abandoned" | "deferred";

export type NoAssistanceStreamState = "ended" | "resolved" | "running";

export function selectNoAssistanceStreamState({
  runHandleStatus,
  terminalStatus,
}: {
  runHandleStatus?: RunHandleStatus | null;
  terminalStatus: TimelineEnvelope["terminal_status"];
}): NoAssistanceStreamState {
  if (terminalStatus === "completed") {
    return "resolved";
  }
  if (terminalStatus === "failed" || terminalStatus === "cancelled" || terminalStatus === "abandoned") {
    return "ended";
  }
  if (runHandleStatus === "completed") {
    return "resolved";
  }
  if (
    runHandleStatus === "failed" ||
    runHandleStatus === "cancelled" ||
    runHandleStatus === "abandoned" ||
    runHandleStatus === "deferred" ||
    runHandleStatus === "expired" ||
    runHandleStatus === "released" ||
    runHandleStatus === "surface_failed"
  ) {
    return "ended";
  }
  return "running";
}

export function resolveNoAssistanceEndedTerminalStatus({
  runHandleStatus,
  terminalStatus,
}: {
  runHandleStatus?: RunHandleStatus | null;
  terminalStatus: TimelineEnvelope["terminal_status"];
}): NoAssistanceEndedStatus {
  if (terminalStatus === "cancelled" || terminalStatus === "abandoned" || terminalStatus === "failed") {
    return terminalStatus;
  }
  if (runHandleStatus === "cancelled") {
    return "cancelled";
  }
  if (runHandleStatus === "abandoned") {
    return "abandoned";
  }
  if (runHandleStatus === "deferred") {
    return "deferred";
  }
  return "failed";
}

/**
 * One owner-facing sentence for a run that has ended, shared by the stream
 * page's ended surface and the live viewer's `run_ended` handling so both say
 * the same thing. `failureMessage` is the run-status failure summary's
 * runtime-authored message (never connector-authored error text).
 */
export function describeEndedRun({
  failureMessage,
  status,
}: {
  failureMessage: string | null;
  status: RunHandleStatus | null;
}): string {
  const state = selectNoAssistanceStreamState({ runHandleStatus: status, terminalStatus: null });
  if (state === "resolved") {
    return "This sync finished.";
  }
  if (state === "running") {
    return "This sync has ended.";
  }
  const ended = resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: status, terminalStatus: null });
  if (ended === "cancelled") {
    return "This sync was cancelled.";
  }
  if (ended === "abandoned") {
    return "This sync stopped before it finished.";
  }
  if (ended === "deferred") {
    return "This sync could not start because no secure browser slot was available.";
  }
  return failureMessage ? `This sync failed: ${failureMessage}` : "This sync failed.";
}
