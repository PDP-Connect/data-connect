// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatGapReason } from "../../lib/run-gaps.ts";
import type { RejectedRecordReceipt, RunRejectionSummary } from "../../lib/run-rejections.ts";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Records the server rejected for good, and evidence the connector could not
 * account for. `receipts` is null when the receipt list could not be read: the
 * count still renders, from the run's own events.
 */
export function RejectedRecordsSection({
  receipts,
  summary,
}: {
  receipts: readonly RejectedRecordReceipt[] | null;
  summary: RunRejectionSummary;
}) {
  if (summary.rejectedRecords === 0 && summary.unaccounted.length === 0) {
    return null;
  }
  return (
    <section className="mb-8 rounded-md border border-[color:var(--warning)]/35 bg-[color:var(--warning-wash)]/45 px-4 py-3 shadow-[inset_3px_0_0_0_var(--warning)]">
      {summary.rejectedRecords > 0 ? (
        <div>
          <h3 className="pdpp-eyebrow">Rejected records</h3>
          <p className="pdpp-caption text-muted-foreground">
            The server permanently rejected {plural(summary.rejectedRecords, "record")} in this run. The other records
            were stored.
            {summary.rejectedRecordsComplete ? "" : " The count covers the events loaded on this page."}
          </p>
          {receipts && receipts.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {receipts.map((receipt) => (
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
        </div>
      ) : null}
      {summary.unaccounted.length > 0 ? (
        <div className={summary.rejectedRecords > 0 ? "mt-4" : undefined}>
          <h3 className="pdpp-eyebrow">Unaccounted records</h3>
          <p className="pdpp-caption text-muted-foreground">
            The connector reported records it could not account for. It reports counts only, so which records is not
            known.
          </p>
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
        </div>
      ) : null}
    </section>
  );
}
