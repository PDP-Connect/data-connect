// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permanent source loss stays VISIBLE as accounted-but-not-hydrated loss and
 * never reads as complete, and it never offers a refetch.
 *
 * Existing vocabulary reused (no shoehorning into pressure or system_issue):
 *   - coverage axis `terminal_gap` (already "no recovery path");
 *   - `pending_detail_gaps` keeps meaning "recoverable pending gaps", so a
 *     permanent gap is counted separately as `permanent_detail_gaps`
 *     (proposed optional field on the runtime collection fact);
 *   - forward disposition for a `terminal_gap` is never `resumable`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { deriveSourcePressureBacklog } from "../runtime/connection-health.ts";
import { buildCollectionFacts } from "../runtime/connector-gap-bounding.ts";
import { deriveStreamCoverageCondition } from "../server/connector-coverage-policy.ts";
import { mapPendingPressureGaps } from "../server/pending-pressure-gap-map.ts";
import { buildCollectionReport, type RuntimeCollectionFact } from "../server/ref-control.ts";

type BuildCollectionFactsInput = Parameters<typeof buildCollectionFacts>[0];

function factsInput(durableDetailGaps: BuildCollectionFactsInput["durableDetailGaps"]): BuildCollectionFactsInput {
  return {
    committedStateStreams: new Set<string>(),
    detailCoverageByStateStream: new Map(),
    durableDetailGaps,
    emittedByStream: new Map(),
    knownGaps: [],
    manifestStateStreamByStream: new Map(),
    newState: null,
    persistState: true,
    scopeByStream: new Map([["other_items", { name: "other_items" }]]),
  };
}

function durableGap(retryable: boolean | null, reason: string) {
  return {
    gap_id: `gap_${reason}_${String(retryable)}`,
    kind: "detail_gap",
    reason,
    retryable,
    status: "pending",
    stream: "other_items",
  } as unknown as BuildCollectionFactsInput["durableDetailGaps"][number];
}

function streamEntry(input: BuildCollectionFactsInput): Record<string, unknown> {
  const facts = buildCollectionFacts(input);
  assert.ok(facts, "a forward run produces a fact block");
  const entry = facts.streams.find((stream) => (stream as { stream: string }).stream === "other_items");
  assert.ok(entry);
  return entry as Record<string, unknown>;
}

test("collection facts count permanent gaps separately from recoverable pending gaps", () => {
  const entry = streamEntry(
    factsInput([
      durableGap(false, "source_unrepresentable"),
      durableGap(true, "temporary_unavailable"),
      durableGap(null, "retry_exhausted"),
    ])
  );
  assert.equal(entry.pending_detail_gaps, 2, "retryable:true and legacy NULL are recoverable pending");
  assert.equal(entry.permanent_detail_gaps, 1, "the permanent gap is accounted, not recoverable");
});

test("a stream with only permanent gaps reports zero recoverable pending gaps", () => {
  const entry = streamEntry(factsInput([durableGap(false, "source_unrepresentable")]));
  assert.equal(entry.pending_detail_gaps, 0);
  assert.equal(entry.permanent_detail_gaps, 1);
});

test("a stream with no permanent gaps omits or zeroes permanent_detail_gaps (old-shape facts stay valid)", () => {
  const entry = streamEntry(factsInput([durableGap(true, "temporary_unavailable")]));
  assert.ok(entry.permanent_detail_gaps === undefined || entry.permanent_detail_gaps === 0);
});

function fact(overrides: Partial<RuntimeCollectionFact> & { permanent_detail_gaps?: number }): RuntimeCollectionFact {
  return {
    checkpoint: "committed",
    collected: 1,
    considered: 2,
    covered: 1,
    pending_detail_gaps: 0,
    skipped: null,
    stream: "other_items",
    ...overrides,
  } as RuntimeCollectionFact;
}

test("coverage policy: permanent loss reads terminal_gap, never complete, even with a full considered/covered count", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ considered: 2, covered: 2, permanent_detail_gaps: 1 }), undefined),
    "terminal_gap"
  );
});

test("coverage policy: recoverable pending work still dominates a co-existing permanent gap", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ pending_detail_gaps: 1, permanent_detail_gaps: 1 }), undefined),
    "retryable_gap"
  );
});

test("coverage policy: a fact without permanent_detail_gaps is unchanged", () => {
  assert.equal(deriveStreamCoverageCondition(fact({ pending_detail_gaps: 1 }), undefined), "retryable_gap");
});

function report(pendingDetailGaps: NonNullable<Parameters<typeof buildCollectionReport>[0]["pendingDetailGaps"]>) {
  return buildCollectionReport({
    attentionOpen: false,
    collectionFacts: null,
    freshness: "fresh",
    manifestStreams: [{ name: "other_items" }],
    pendingDetailGaps,
    refresh: null,
  });
}

test("live gap reads: a permanent pending gap reads terminal_gap, is not resumable, and is not a recoverable count", () => {
  const [entry] = report([
    { reason: "source_unrepresentable", retryable: false, status: "pending", stream: "other_items" },
  ]);
  assert.ok(entry);
  assert.equal(entry.coverage_condition, "terminal_gap");
  assert.notEqual(entry.forward_disposition, "resumable", "no refetch is offered for permanent loss");
  assert.equal(entry.pending_detail_gaps, 0);
});

test("live gap reads: recoverable and legacy NULL gaps still read retryable_gap / resumable", () => {
  for (const retryable of [true, null, undefined]) {
    const [entry] = report([
      { reason: "temporary_unavailable", status: "pending", stream: "other_items", ...(retryable === undefined ? {} : { retryable }) },
    ]);
    assert.ok(entry);
    assert.equal(entry.coverage_condition, "retryable_gap", String(retryable));
    assert.equal(entry.forward_disposition, "resumable");
    assert.equal(entry.pending_detail_gaps, 1);
  }
});

test("live gap reads: mixed permanent and recoverable gaps count only the recoverable ones", () => {
  const [entry] = report([
    { reason: "source_unrepresentable", retryable: false, status: "pending", stream: "other_items" },
    { reason: "temporary_unavailable", retryable: true, status: "pending", stream: "other_items" },
  ]);
  assert.ok(entry);
  assert.equal(entry.coverage_condition, "retryable_gap");
  assert.equal(entry.pending_detail_gaps, 1);
});

test("source-pressure backlog rollup excludes permanent gaps from pending and pending_other", () => {
  const backlog = deriveSourcePressureBacklog({
    pendingGaps: [
      { attemptCount: 0, lastPressureAt: null, nextAttemptAfter: null, reason: "rate_limited", retryable: false },
      { attemptCount: 0, lastPressureAt: null, nextAttemptAfter: null, reason: "source_unrepresentable", retryable: false },
      { attemptCount: 0, lastPressureAt: null, nextAttemptAfter: null, reason: "rate_limited", retryable: true },
      { attemptCount: 0, lastPressureAt: null, nextAttemptAfter: null, reason: "retry_exhausted" },
    ] as never,
    unreadable: false,
  });
  assert.ok(backlog);
  assert.equal(backlog.pending, 1, "only the retryable pressure gap is pressure backlog");
  assert.equal(backlog.pending_other, 1, "only the legacy retry_exhausted gap is other recoverable work");
});

test("mapPendingPressureGaps carries the explicit retryable discriminator and leaves legacy rows without one", () => {
  const mapped = mapPendingPressureGaps([
    { reason: "rate_limited", retryable: false, status: "pending", stream: "s" },
    { reason: "rate_limited", retryable: true, status: "pending", stream: "s" },
    { reason: "rate_limited", status: "pending", stream: "s" },
  ] as never);
  assert.deepEqual(
    mapped.map((gap) => (gap as { retryable?: boolean | null }).retryable ?? null),
    [false, true, null]
  );
});
