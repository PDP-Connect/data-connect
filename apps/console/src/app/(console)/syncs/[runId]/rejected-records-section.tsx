// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatGapReason } from "../../lib/run-gaps.ts";
import type { RunRecordRejectionReceipts } from "../../lib/ref-client.ts";
import type { RunRejectionSummary } from "../../lib/run-rejections.ts";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function rejectedSentence(rejected: RunRejectionSummary["rejected"]): string {
  switch (rejected.kind) {
    case "final":
      return `The server permanently rejected ${plural(rejected.count, "record")} in this run.`;
    case "so_far":
      return `The server has permanently rejected ${plural(rejected.count, "record")} so far. This run is still in progress.`;
    case "at_least":
      return `The server permanently rejected at least ${plural(rejected.count, "record")} in this run. The count covers only the events loaded on this page.`;
    default:
      return "This run's rejected-record count is not available here: the events that carry it are not on this page, or the server did not report it.";
  }
}

/**
 * Records the server rejected for good, and evidence the connector could not
 * account for. A zero is stated only when it is known: a count that cannot be
 * read renders as unavailable, never as nothing. `receipts` is null when the
 * receipt list could not be read.
 */
export function RejectedRecordsSection({
  receipts,
  summary,
}: {
  receipts: RunRecordRejectionReceipts | null;
  summary: RunRejectionSummary;
}) {
  const { rejected } = summary;
  const showRejected = rejected.kind === "unknown" || rejected.count > 0;
  const showUnaccounted = summary.unaccounted.length > 0 || !summary.unaccountedComplete;
  if (!(showRejected || showUnaccounted)) {
    return null;
  }
  return (
    <section className="mb-8 rounded-md border border-[color:var(--warning)]/35 bg-[color:var(--warning-wash)]/45 px-4 py-3 shadow-[inset_3px_0_0_0_var(--warning)]">
      {showRejected ? (
        <div>
          <h3 className="pdpp-eyebrow">Rejected records</h3>
          <p className="pdpp-caption text-muted-foreground">{rejectedSentence(rejected)}</p>
          {rejected.kind !== "unknown" && receipts === null ? (
            <p className="pdpp-caption mt-2 text-muted-foreground">The receipt list is unavailable.</p>
          ) : null}
          {receipts && receipts.receipts.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {receipts.receipts.map((receipt) => (
                <li className="rounded-md border border-border/70 bg-background/70 px-3 py-2" key={receipt.receiptId}>
                  <div className="pdpp-caption flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-muted-foreground">stream</span>
                    <code>{receipt.stream}</code>
                    <span className="text-muted-foreground">reason</span>
                    <code>{formatGapReason(receipt.reasonCode)}</code>
                    {receipt.firstInputIndex === null ? null : (
                      <>
                        <span className="text-muted-foreground">position in batch</span>
                        <code>{receipt.firstInputIndex}</code>
                      </>
                    )}
                    {receipt.payloadBytes === null ? null : (
                      <>
                        <span className="text-muted-foreground">size</span>
                        <code>{receipt.payloadBytes} bytes</code>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {receipts?.truncated ? (
            <p className="pdpp-caption mt-2 text-muted-foreground">
              The receipt list is partial: {plural(receipts.receipts.length, "receipt")} found, and more may exist.
            </p>
          ) : null}
        </div>
      ) : null}
      {showUnaccounted ? (
        <div className={showRejected ? "mt-4" : undefined}>
          <h3 className="pdpp-eyebrow">Unaccounted records</h3>
          <p className="pdpp-caption text-muted-foreground">
            {summary.unaccounted.length > 0
              ? "The connector reported records it could not account for. It reports counts only, so which records is not known."
              : "No unaccounted records are listed."}
            {summary.unaccountedComplete
              ? ""
              : " Only part of this run's timeline is loaded, so streams reported on other pages are not listed."}
          </p>
          {summary.unaccounted.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {summary.unaccounted.map((entry) => (
                <li className="rounded-md border border-border/70 bg-background/70 px-3 py-2" key={entry.stream}>
                  <div className="pdpp-caption flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-muted-foreground">stream</span>
                    <code>{entry.stream}</code>
                    <span className="text-foreground">{plural(entry.unaccounted, "unaccounted record")}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
