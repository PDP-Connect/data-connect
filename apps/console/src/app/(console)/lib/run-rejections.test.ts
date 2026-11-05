// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpineEvent } from "./ref-client.ts";
import { receiptsForRun, rejectedCount, summarizeRunRejections } from "./run-rejections.ts";

let eventSequence = 0;

function event(event_type: string, data: Record<string, unknown>, stream_id: string | null = null): SpineEvent {
  eventSequence += 1;
  return {
    actor_id: "connector",
    actor_type: "runtime",
    client_id: null,
    data,
    event_id: `event_${eventSequence}`,
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

const batch = (rejected: number, stream = "messages") =>
  event("run.batch_ingested", { records_permanently_rejected: rejected }, stream);

const whole = { statusTotal: null, timelineComplete: true };
const partial = { statusTotal: null, timelineComplete: false };

test("the run status total is the final count whatever the page holds", () => {
  const summary = summarizeRunRejections([], { statusTotal: 7, timelineComplete: false });
  assert.deepEqual(summary.rejected, { count: 7, kind: "final" });
  assert.equal(rejectedCount(summary), 7);
});

test("a reported total of zero is final, not unknown", () => {
  const summary = summarizeRunRejections([], { statusTotal: 0, timelineComplete: false });
  assert.deepEqual(summary.rejected, { count: 0, kind: "final" });
});

test("the terminal event's total is final and wins over the batch sum", () => {
  const summary = summarizeRunRejections(
    [batch(1), event("run.completed", { records_permanently_rejected: 2 })],
    whole,
  );
  assert.deepEqual(summary.rejected, { count: 2, kind: "final" });
});

test("a run with every event loaded and no terminal event sums its batches so far", () => {
  const summary = summarizeRunRejections([batch(1), batch(2, "threads"), batch(0, "threads")], whole);
  assert.deepEqual(summary.rejected, { count: 3, kind: "so_far" });
});

test("a partial page with rejected batches reports at least that many", () => {
  const summary = summarizeRunRejections([batch(1), batch(2, "threads")], partial);
  assert.deepEqual(summary.rejected, { count: 3, kind: "at_least" });
});

test("a partial page with no rejected batch cannot state a zero", () => {
  const summary = summarizeRunRejections([batch(0), event("run.progress_reported", {})], partial);
  assert.deepEqual(summary.rejected, { kind: "unknown" });
  assert.equal(rejectedCount(summary), 0);
});

test("batch events without the field cannot state a zero", () => {
  const legacy = event("run.batch_ingested", { records_accepted: 4 }, "messages");
  assert.deepEqual(summarizeRunRejections([legacy], whole).rejected, { kind: "unknown" });
});

test("a terminal event without the field and no status total cannot state a zero", () => {
  const summary = summarizeRunRejections([batch(0), event("run.completed", {})], whole);
  assert.deepEqual(summary.rejected, { kind: "unknown" });
});

test("unaccounted counts are listed per stream and merged when a stream declares evidence twice", () => {
  const summary = summarizeRunRejections(
    [
      event("run.stream_evidence_declared", { outcomes: { unaccounted: 2 } }, "bodies"),
      event("run.stream_evidence_declared", { outcomes: { unaccounted: 0 } }, "labels"),
      event("run.stream_evidence_declared", { outcomes: { unaccounted: 1 } }, "bodies"),
    ],
    whole,
  );
  assert.deepEqual(summary.unaccounted, [{ stream: "bodies", unaccounted: 3 }]);
  assert.equal(summary.unaccountedComplete, true);
});

test("unaccounted streams are marked incomplete when the page is not the whole timeline", () => {
  assert.equal(summarizeRunRejections([], partial).unaccountedComplete, false);
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
      { firstInputIndex: 4, payloadBytes: 120, reasonCode: "schema_violation", receiptId: "r1", stream: "messages" },
    ],
  });
  assert.deepEqual(receiptsForRun(null, "run_1"), { nextCursor: null, receipts: [] });
});
