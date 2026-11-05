// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a run could not store or account for, read from facts the server
 * already records: per-batch `records_permanently_rejected` on
 * `run.batch_ingested`, the run total on the terminal event, `outcomes.unaccounted`
 * on `run.stream_evidence_declared`, and the per-connection record-rejection
 * receipts the server lists for the owner.
 */

import type { SpineEvent } from "./ref-client.ts";

export interface UnaccountedStream {
  stream: string;
  unaccounted: number;
}

export interface RunRejectionSummary {
  /**
   * True when `rejectedRecords` is the run's own total from the terminal event,
   * false when it is summed from the batch events loaded on this page.
   */
  rejectedRecordsComplete: boolean;
  rejectedRecords: number;
  unaccounted: UnaccountedStream[];
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

const TERMINAL_EVENT_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function summarizeRunRejections(
  events: readonly SpineEvent[],
): RunRejectionSummary {
  let batchTotal = 0;
  let terminalTotal: number | null = null;
  const unaccounted: UnaccountedStream[] = [];
  for (const event of events) {
    if (event.event_type === "run.batch_ingested") {
      batchTotal +=
        nonNegativeInteger(event.data?.records_permanently_rejected) ?? 0;
    } else if (TERMINAL_EVENT_TYPES.has(event.event_type)) {
      terminalTotal =
        nonNegativeInteger(event.data?.records_permanently_rejected) ??
        terminalTotal;
    } else if (event.event_type === "run.stream_evidence_declared") {
      const outcomes = event.data?.outcomes as
        | { unaccounted?: unknown }
        | null
        | undefined;
      const count = nonNegativeInteger(outcomes?.unaccounted);
      if (count && event.stream_id) {
        unaccounted.push({ stream: event.stream_id, unaccounted: count });
      }
    }
  }
  return {
    rejectedRecords: terminalTotal ?? batchTotal,
    rejectedRecordsComplete: terminalTotal !== null,
    unaccounted,
  };
}

/** One page of `GET /_ref/connections/:id/record-rejections`, narrowed to one run's receipts. */
export function receiptsForRun(
  body: unknown,
  runId: string,
): RecordRejectionReceiptPage {
  const page = (body ?? {}) as { data?: unknown; next_cursor?: unknown };
  const items = Array.isArray(page.data) ? page.data : [];
  const receipts: RejectedRecordReceipt[] = [];
  for (const item of items as Record<string, unknown>[]) {
    if (
      item?.run_id !== runId ||
      typeof item.receipt_id !== "string" ||
      typeof item.stream !== "string"
    ) {
      continue;
    }
    receipts.push({
      firstInputIndex: nonNegativeInteger(item.first_input_index),
      payloadBytes: nonNegativeInteger(item.payload_bytes),
      reasonCode:
        typeof item.reason_code === "string" ? item.reason_code : "unknown",
      receiptId: item.receipt_id,
      stream: item.stream,
    });
  }
  return {
    nextCursor: typeof page.next_cursor === "string" ? page.next_cursor : null,
    receipts,
  };
}
