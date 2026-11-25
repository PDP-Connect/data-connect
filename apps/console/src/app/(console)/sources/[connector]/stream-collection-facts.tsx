// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type StreamCollectionFacts, streamOwnerActionCueNeeded } from "../../lib/collection-report.ts";

/**
 * Per-stream collection facts rendered under a stream row on the connector
 * detail page. Surfaces the reference's derived Collection Report
 * (`define-connector-progress-evidence-contract`) so an operator sees, per
 * stream, whether the last run's coverage is complete / resuming / won't
 * backfill, what the next run will do, and the objective collected count —
 * not just a record total.
 *
 * Honest-by-default (the formatter enforces it): an unknown considered
 * denominator never renders a fabricated fraction. These facts stay plain and
 * folded under Details so the stream list remains a short list of kinds.
 *
 * Renders `null` when there is nothing to say (no entry for this stream), so a
 * reference predating the field — or a stream with no report entry — leaves the
 * row exactly as it was.
 */
export function StreamCollectionFactsLine({
  facts,
  ownerActionAvailable = true,
}: {
  facts: StreamCollectionFacts | null;
  ownerActionAvailable?: boolean;
}) {
  if (!facts) {
    return null;
  }
  const { coverage, disposition, countsLabel, countsTitle, pendingDetailGaps, pendingDetailGapsLabel, skipLabel } =
    facts;
  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2" data-stream={facts.stream} data-testid="stream-collection-facts">
      <p className="pdpp-caption text-muted-foreground" data-testid="stream-coverage-fact" title={coverage.title}>
        {coverage.dimension.toLowerCase() === "coverage" ? "Records" : coverage.dimension}: {coverage.value}
      </p>

      {disposition ? (
        <span
          className="pdpp-caption text-muted-foreground"
          data-disposition={disposition.value}
          data-testid="stream-forward-disposition"
          title={disposition.title}
        >
          Next sync: {disposition.label}
          {streamOwnerActionCueNeeded(disposition, ownerActionAvailable) ? (
            <span className="ml-1 text-muted-foreground">(needs you)</span>
          ) : null}
        </span>
      ) : null}

      {countsLabel ? (
        <span
          className="pdpp-caption text-muted-foreground tabular-nums"
          data-testid="stream-collected-counts"
          title={countsTitle}
        >
          {countsLabel}
        </span>
      ) : null}

      {pendingDetailGaps > 0 ? (
        <span
          className="pdpp-caption text-muted-foreground tabular-nums"
          data-testid="stream-pending-gaps"
          title={
            facts.pendingDetailGapsIsFloor
              ? "Recoverable detail gaps from a bounded read; there may be more beyond this count. Records already collected stay valid."
              : "Recoverable detail gaps the next sync is expected to fill. Records already collected stay valid."
          }
        >
          {pendingDetailGapsLabel ?? "pending gaps"}
        </span>
      ) : null}

      {skipLabel ? (
        <span
          className="pdpp-caption text-muted-foreground"
          data-testid="stream-skip-label"
          title="The system reported this kind of record as skipped on the last sync."
        >
          {skipLabel}
        </span>
      ) : null}
    </div>
  );
}


