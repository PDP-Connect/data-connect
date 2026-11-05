// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpineEvent } from "./ref-client.ts";
import { receiptsForRun, summarizeRunRejections } from "./run-rejections.ts";

function event(
  event_type: string,
  data: Record<string, unknown>,
  stream_id: string | null = null,
): SpineEvent {
  return {
    actor_id: "connector",
    actor_type: "runtime",
    client_id: null,
    data,
    event_id: `${event_type}-${stream_id ?? "run"}-${Math.random()}`,
    event_type,
    grant_id: null,
    interaction_id: null,
    object_id: "run_1",
    object_type: "run",
    occurred_at: "2026-11-05T00:00:00.000Z",
    recorded_at: "2026-11-05T00:00:00.000Z",
    request_id: null,
    run_id: "run_1",
    scenario_id: null,
    status: "succeeded",
    stream_id,
    subject_id: null,
    subject_type: null,
    token_id: null,
    trace_id: "trace_1",
    version: "1",
  };
}

test("rejected records are summed from batch events while the terminal event is not loaded", () => {
  const summary = summarizeRunRejections([
    event(
      "run.batch_ingested",
      { records_permanently_rejected: 1 },
      "messages",
    ),
    event("run.batch_ingested", { records_permanently_rejected: 2 }, "threads"),
    event("run.batch_ingested", { records_permanently_rejected: 0 }, "threads"),
  ]);
  assert.equal(summary.rejectedRecords, 3);
  assert.equal(summary.rejectedRecordsComplete, false);
});

test("the terminal event's run total wins over the batch sum", () => {
  const summary = summarizeRunRejections([
    event(
      "run.batch_ingested",
      { records_permanently_rejected: 1 },
      "messages",
    ),
    event("run.completed", { records_permanently_rejected: 2 }),
  ]);
  assert.equal(summary.rejectedRecords, 2);
  assert.equal(summary.rejectedRecordsComplete, true);
});

test("a run with no rejections and no evidence summarizes to nothing", () => {
  const summary = summarizeRunRejections([
    event("run.batch_ingested", { records_accepted: 4 }, "messages"),
  ]);
  assert.deepEqual(summary, {
    rejectedRecords: 0,
    rejectedRecordsComplete: false,
    unaccounted: [],
  });
});

test("only STREAM_EVIDENCE streams with an unaccounted count are listed", () => {
  const summary = summarizeRunRejections([
    event(
      "run.stream_evidence_declared",
      { outcomes: { emitted: 3, gapped: 0, unaccounted: 2, unchanged: 0 } },
      "bodies",
    ),
    event(
      "run.stream_evidence_declared",
      { outcomes: { emitted: 5, gapped: 0, unaccounted: 0, unchanged: 0 } },
      "labels",
    ),
  ]);
  assert.deepEqual(summary.unaccounted, [{ stream: "bodies", unaccounted: 2 }]);
});

test("receipts are narrowed to the run and keep the page cursor", () => {
  const page = receiptsForRun(
    {
      data: [
        {
          first_input_index: 4,
          payload_bytes: 120,
          reason_code: "schema_violation",
          receipt_id: "r1",
          run_id: "run_1",
          stream: "messages",
        },
        {
          first_input_index: 0,
          payload_bytes: 90,
          reason_code: "schema_violation",
          receipt_id: "r2",
          run_id: "run_2",
          stream: "messages",
        },
      ],
      next_cursor: "next",
    },
    "run_1",
  );
  assert.deepEqual(page, {
    nextCursor: "next",
    receipts: [
      {
        firstInputIndex: 4,
        payloadBytes: 120,
        reasonCode: "schema_violation",
        receiptId: "r1",
        stream: "messages",
      },
    ],
  });
  assert.deepEqual(receiptsForRun(null, "run_1"), {
    nextCursor: null,
    receipts: [],
  });
});
