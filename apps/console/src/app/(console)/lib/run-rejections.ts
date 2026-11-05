// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a run could not store or account for, read from facts the server
 * already records: the run total of `records_permanently_rejected` (run status,
 * or the terminal event), per-batch `records_permanently_rejected` on
 * `run.batch_ingested`, `outcomes.unaccounted` on
 * `run.stream_evidence_declared`, and the per-connection record-rejection
 * receipts the server lists for the owner.
 *
 * A timeline page holds only part of a long run, so the summary never reports
 * a zero it cannot prove: see `RejectedTotal`.
 */

import type { SpineEvent } from "./ref-client.ts";

export interface UnaccountedStream {
  stream: string;
  unaccounted: number;
}

/**
 * How much of the run's rejected-record total this page can state.
 * - `final`: the run's own total (run status, or the terminal event).
 * - `so_far`: no terminal event yet and every event is loaded, so the sum is
 *   the total up to now.
 * - `at_least`: the sum of the batch events loaded, with part of the run not
 *   readable here.
 * - `unknown`: nothing readable, and a zero cannot be told from a gap.
 */
export type RejectedTotal = { count: number; kind: "final" | "so_far" | "at_least" } | { kind: "unknown" };

export interface RunRejectionSummary {
  rejected: RejectedTotal;
  /**
   * False when the timeline page does not hold every event of the run: streams
   * whose evidence events are on other pages are not listed.
   */
  unaccountedComplete: boolean;
  unaccounted: UnaccountedStream[];
}

export interface RunRejectionInputs {
  /** The run's rejected total from the run-status projection, when the server reports it. */
  statusTotal: number | null;
  /** True when this page is the whole timeline: first page, nothing truncated. */
  timelineComplete: boolean;
}

/** The count to show, or 0 when the summary cannot state one. */
export function rejectedCount(summary: RunRejectionSummary): number {
  return summary.rejected.kind === "unknown" ? 0 : summary.rejected.count;
}

export interface RejectedRecordReceipt {
  firstInputIndex: number | null;
  payloadBytes: number | null;
  reasonCode: string;
  receiptId: string;
  stream: string;
}

export interface RecordRejectionReceiptPage {
  nextCursor: string | null;
  receipts: RejectedRecordReceipt[];
}

const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function summarizeRunRejections(
  events: readonly SpineEvent[],
  { statusTotal, timelineComplete }: RunRejectionInputs,
): RunRejectionSummary {
  let batchTotal = 0;
  let batchesWithoutCount = 0;
  let terminalOnPage = false;
  let terminalTotal: number | null = null;
  const unaccountedByStream = new Map<string, number>();
  for (const event of events) {
    if (event.event_type === "run.batch_ingested") {
      const count = nonNegativeInteger(event.data?.records_permanently_rejected);
      if (count === null) {
        batchesWithoutCount += 1;
      } else {
        batchTotal += count;
      }
    } else if (TERMINAL_EVENT_TYPES.has(event.event_type)) {
      terminalOnPage = true;
      terminalTotal = nonNegativeInteger(event.data?.records_permanently_rejected) ?? terminalTotal;
    } else if (event.event_type === "run.stream_evidence_declared") {
      const outcomes = event.data?.outcomes as { unaccounted?: unknown } | null | undefined;
      const count = nonNegativeInteger(outcomes?.unaccounted);
      if (count && event.stream_id) {
        unaccountedByStream.set(event.stream_id, (unaccountedByStream.get(event.stream_id) ?? 0) + count);
      }
    }
  }
  const total = statusTotal ?? terminalTotal;
  let rejected: RejectedTotal;
  if (total !== null) {
    rejected = { count: total, kind: "final" };
  } else if (timelineComplete && !terminalOnPage && batchesWithoutCount === 0) {
    rejected = { count: batchTotal, kind: "so_far" };
  } else if (batchTotal > 0) {
    rejected = { count: batchTotal, kind: "at_least" };
  } else {
    rejected = { kind: "unknown" };
  }
  return {
    rejected,
    unaccounted: [...unaccountedByStream].map(([stream, unaccounted]) => ({
      stream,
      unaccounted,
    })),
    unaccountedComplete: timelineComplete,
  };
}

/** One page of `GET /_ref/connections/:id/record-rejections`, narrowed to one run's receipts. */
export function receiptsForRun(body: unknown, runId: string): RecordRejectionReceiptPage {
  const page = (body ?? {}) as { data?: unknown; next_cursor?: unknown };
  const items = Array.isArray(page.data) ? page.data : [];
  const receipts: RejectedRecordReceipt[] = [];
  for (const item of items as Record<string, unknown>[]) {
    if (item?.run_id !== runId || typeof item.receipt_id !== "string" || typeof item.stream !== "string") {
      continue;
    }
    receipts.push({
      firstInputIndex: nonNegativeInteger(item.first_input_index),
      payloadBytes: nonNegativeInteger(item.payload_bytes),
      reasonCode: typeof item.reason_code === "string" ? item.reason_code : "unknown",
      receiptId: item.receipt_id,
      stream: item.stream,
    });
  }
  return {
    nextCursor: typeof page.next_cursor === "string" ? page.next_cursor : null,
    receipts,
  };
}
