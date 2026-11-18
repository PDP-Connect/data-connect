// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Checkpoint commit decision — which staged STATE_STREAM cursors a run may
 * commit at DONE.
 *
 * THE INVARIANT
 * -------------
 * A cursor may move past a row only when that row is collected or has a
 * durable work item that replays it independently of the cursor. Once a cursor
 * commits, the next run starts after it; anything behind it that nothing
 * durable remembers is lost.
 *
 * A staged STATE_STREAM is withheld when any of these holds:
 *
 * 1. A manifest-declared detail stream of that parent sent no DETAIL_COVERAGE
 *    report for it (`coverage_report_missing`).
 * 2. A DETAIL_COVERAGE report leaves a required key uncredited
 *    (`coverage_shortfall`). A key the RS rejected a record for this run (and
 *    never accepted that record) is uncredited whatever the connector says,
 *    unless a durable gap covers it. Otherwise a key is credited by:
 *    - a hydrated declaration. When the report requires evidence, the
 *      declaration must be backed by an accepted record of the detail stream
 *      for that key: its primary key, or the foreign key of a manifest
 *      relationship to the parent; a bare hydrated listing proves nothing.
 *      See `CoverageReport.hydratedKeysNeedEvidence` for which reports;
 *    - an explicit `empty_keys` or `unchanged_keys` outcome: the connector
 *      verified the key has no detail, or no changed detail, this run;
 *    - an optional-skip declaration (an accepted terminal absence); or
 *    - a pending or recovered durable DETAIL_GAP for the same stream, key and
 *      parent boundary. Declared `gap_keys` alone credit nothing.
 *    Evidence is read once at DONE, after the final flush, so a record sent
 *    after its DETAIL_COVERAGE still counts, for or against the key.
 * 3. A data stream that maps to it reported an omission with no durable work
 *    item (`reported_omission`): a `stream_collection_failed` SKIP_RESULT, a
 *    retryable SKIP_RESULT without a runtime continuation, or STREAM_EVIDENCE
 *    with `outcomes.unaccounted > 0`. Gapped evidence keys are durable
 *    DETAIL_GAPs and do not withhold. An omission that names no stream
 *    withholds every staged cursor: nothing proves any cursor is clear of it.
 *
 * Every other staged STATE_STREAM commits.
 *
 * Pure: no I/O, no clock. The runtime collects the inputs while the run
 * streams, calls this once at DONE, then records the gaps and commits.
 */

/** One DETAIL_COVERAGE report for one (state_stream, detail stream) boundary. */
export interface CoverageReport {
  /** Keys the connector verified have no detail this run. */
  emptyKeys: ReadonlySet<string>;
  /** Keys with an accepted record of `stream` this run, by primary key or parent foreign key. */
  evidencedKeys: ReadonlySet<string>;
  /** Hydrated keys as the connector declared them. */
  hydratedKeys: ReadonlySet<string>;
  /**
   * True when the connector's manifest declares DETAIL_COVERAGE_KEY_SETS: a
   * hydrated key then credits only when `evidencedKeys` holds it. False for a
   * connector without the capability: its hydrated declaration credits by
   * itself, as it did before the capability existed, because such a
   * connector may list a key with no detail record (an empty parent) as
   * hydrated. In both cases `empty_keys` and `unchanged_keys` credit without a
   * record, and a rejection uncredits the key.
   */
  hydratedKeysNeedEvidence: boolean;
  optionalSkipKeys: ReadonlySet<string>;
  /** Keys with a record of `stream` the RS rejected this run and never accepted. */
  rejectedKeys: ReadonlySet<string>;
  requiredKeys: readonly string[];
  stream: string;
  /** Keys the connector verified have no changed detail this run. */
  unchangedKeys: ReadonlySet<string>;
}

/**
 * The required keys the run accounted for: hydrated (with evidence when the
 * report needs it), verified empty, or verified unchanged, and not
 * contradicted by a rejection. Optional skips and gaps release a checkpoint
 * but are not coverage, so a declared `covered` count never exceeds this.
 */
export function coveredRequiredKeys(report: CoverageReport): string[] {
  return report.requiredKeys.filter(
    (key) =>
      !report.rejectedKeys.has(key) &&
      ((report.hydratedKeys.has(key) && (!report.hydratedKeysNeedEvidence || report.evidencedKeys.has(key))) ||
        report.emptyKeys.has(key) ||
        report.unchangedKeys.has(key))
  );
}

/** The fields of a durable detail-gap row that can credit a required key. */
export interface DurableGapEvidence {
  parent_stream?: string | null;
  record_key?: string | number | null;
  status?: string;
  stream?: string;
}

export type OmissionSource = "retryable_skip" | "stream_collection_failed" | "unaccounted_evidence";

/**
 * A report of rows a run did not collect. `stream` is the data stream that
 * omitted them, or null when the report named none: then no cursor is known
 * to be clear of the omitted rows, so it withholds every staged cursor.
 */
export interface ReportedOmission {
  source: OmissionSource;
  stream: string | null;
}

export interface CheckpointCommitInput {
  /** Manifest `parent_streams` per detail stream. */
  readonly detailParentsByStream: ReadonlyMap<string, ReadonlySet<string>>;
  readonly coverageByStateStream: ReadonlyMap<string, readonly CoverageReport[]>;
  readonly durableGaps: readonly DurableGapEvidence[];
  readonly inScopeStreams: ReadonlySet<string>;
  readonly omissions: readonly ReportedOmission[];
  /** Staged STATE_STREAM keys, in staging order. */
  readonly stagedStateStreams: readonly string[];
  /** Manifest `state_stream` per data stream. */
  readonly stateStreamByStream: ReadonlyMap<string, string>;
}

export type WithholdReason =
  | { kind: "coverage_report_missing"; stateStream: string; stream: string }
  | {
      kind: "coverage_shortfall";
      missingKeyCount: number;
      requiredKeyCount: number;
      stateStream: string;
      stream: string;
    }
  | { kind: "reported_omission"; source: OmissionSource; stateStream: string; stream: string | null };

export interface CheckpointCommitDecision {
  /** STATE_STREAM keys to commit, in staging order. */
  commit: string[];
  /** Every reason, grouped by staged STATE_STREAM in staging order. */
  withheld: WithholdReason[];
}

export function decideCheckpointCommits(input: CheckpointCommitInput): CheckpointCommitDecision {
  const commit: string[] = [];
  const withheld: WithholdReason[] = [];
  for (const stateStream of input.stagedStateStreams) {
    const reasons = [
      ...missingCoverageReports(input, stateStream),
      ...coverageShortfalls(input, stateStream),
      ...omissionsOwnedBy(input, stateStream),
    ];
    if (reasons.length) {
      withheld.push(...reasons);
    } else {
      commit.push(stateStream);
    }
  }
  return { commit, withheld };
}

/**
 * Every STATE_STREAM that owns a data stream's checkpoint. Manifest declaration
 * is authoritative: a `parent_streams` stream names every declared parent,
 * whether or not that parent got a live DETAIL_COVERAGE report (an omitting
 * stream's live evidence is incomplete, so trusting only what arrived would
 * under-withhold). Otherwise the static `state_stream`, else the stream itself.
 */
function stateStreamsOwning(
  dataStream: string,
  input: Pick<CheckpointCommitInput, "detailParentsByStream" | "stateStreamByStream">
): ReadonlySet<string> {
  const declaredParents = input.detailParentsByStream.get(dataStream);
  if (declaredParents?.size) {
    return declaredParents;
  }
  return new Set([input.stateStreamByStream.get(dataStream) || dataStream]);
}

function missingCoverageReports(input: CheckpointCommitInput, stateStream: string): WithholdReason[] {
  const reports = input.coverageByStateStream.get(stateStream) || [];
  const reasons: WithholdReason[] = [];
  for (const [stream, parents] of input.detailParentsByStream) {
    if (
      input.inScopeStreams.has(stream) &&
      parents.has(stateStream) &&
      !reports.some((report) => report.stream === stream)
    ) {
      reasons.push({ kind: "coverage_report_missing", stateStream, stream });
    }
  }
  return reasons;
}

function coverageShortfalls(input: CheckpointCommitInput, stateStream: string): WithholdReason[] {
  const reasons: WithholdReason[] = [];
  for (const report of input.coverageByStateStream.get(stateStream) || []) {
    const gapKeys = durableGapKeys(input, report.stream, stateStream);
    const covered = new Set(coveredRequiredKeys(report));
    const missingKeyCount = report.requiredKeys.filter(
      (key) =>
        !(gapKeys.has(key) || covered.has(key) || (report.optionalSkipKeys.has(key) && !report.rejectedKeys.has(key)))
    ).length;
    if (missingKeyCount) {
      reasons.push({
        kind: "coverage_shortfall",
        missingKeyCount,
        requiredKeyCount: report.requiredKeys.length,
        stateStream,
        stream: report.stream,
      });
    }
  }
  return reasons;
}

/**
 * Keys of pending or recovered durable gaps for `stream` under `stateStream`.
 * A gap with no parent can stand for a single-parent stream only; for a
 * multi-parent stream it cannot say which boundary it belongs to.
 */
function durableGapKeys(input: CheckpointCommitInput, stream: string, stateStream: string): Set<string> {
  const hasMultipleParents = (input.detailParentsByStream.get(stream)?.size || 0) > 1;
  const keys = new Set<string>();
  for (const gap of input.durableGaps) {
    if (
      gap.stream === stream &&
      (gap.status === "pending" || gap.status === "recovered") &&
      (gap.parent_stream ? gap.parent_stream === stateStream : !hasMultipleParents) &&
      gap.record_key !== null &&
      gap.record_key !== undefined
    ) {
      keys.add(String(gap.record_key));
    }
  }
  return keys;
}

function omissionsOwnedBy(input: CheckpointCommitInput, stateStream: string): WithholdReason[] {
  return input.omissions
    .filter((omission) => omission.stream === null || stateStreamsOwning(omission.stream, input).has(stateStream))
    .map((omission) => ({ kind: "reported_omission", source: omission.source, stateStream, stream: omission.stream }));
}

/**
 * Consecutive runs a state stream's cursor may be withheld for the same reason
 * before the runtime reports a stall to the owner rather than a transient gap.
 */
export const CHECKPOINT_STALL_RUNS = 3;

/** One reason as a short, stable phrase; counts are left out so it is equal run to run. */
export function describeWithholdReason(reason: WithholdReason): string {
  const stream = reason.stream ?? "an unnamed stream";
  switch (reason.kind) {
    case "coverage_report_missing":
      return `no DETAIL_COVERAGE report from ${stream}`;
    case "coverage_shortfall":
      return `${stream} left required keys uncredited`;
    default:
      return `${stream} reported an omission (${reason.source})`;
  }
}

/** A stable identity for one state stream's set of reasons: same reasons, same key. */
export function withholdReasonKey(reasons: readonly WithholdReason[]): string {
  return [...new Set(reasons.map(describeWithholdReason))].sort().join("; ");
}
