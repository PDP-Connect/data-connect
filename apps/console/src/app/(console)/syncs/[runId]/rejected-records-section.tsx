// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordRejectionReceiptPage, RunRecordOutcomes } from "../../lib/ref-client.ts";
import { formatGapReason } from "../../lib/run-gaps.ts";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Records the server rejected for good, and records the connector could not
 * account for. It shows the server's whole-run totals and one page of the run's
 * receipts; it computes nothing. `receipts` is null when the list was not read
 * or the read failed. A total the server did not report is not shown as zero.
 */
export function RejectedRecordsSection({
  moreReceiptsHref,
  outcomes,
  receipts,
}: {
  moreReceiptsHref: string | null;
  outcomes: RunRecordOutcomes | null;
  receipts: RecordRejectionReceiptPage | null;
}) {
  const rejected = outcomes?.permanently_rejected ?? null;
  const unaccounted = Object.entries(outcomes?.unaccounted_by_stream ?? {});
  const listedReceipts = receipts?.receipts ?? [];
  const showRejected = (rejected ?? 0) > 0 || listedReceipts.length > 0;
  if (!(showRejected || unaccounted.length > 0)) {
    return null;
  }
  return (
    <section className="mb-8 rounded-md border border-[color:var(--warning)]/35 bg-[color:var(--warning-wash)]/45 px-4 py-3 shadow-[inset_3px_0_0_0_var(--warning)]">
      {showRejected ? (
        <div>
          <h3 className="pdpp-eyebrow">Rejected records</h3>
          {rejected === null ? null : (
            <p className="pdpp-caption text-muted-foreground">
              The server permanently rejected {plural(rejected, "record")} in this run.
            </p>
          )}
          {receipts === null ? (
            <p className="pdpp-caption mt-2 text-muted-foreground">The receipt list is unavailable.</p>
          ) : null}
          {listedReceipts.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {listedReceipts.map((receipt) => (
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
          {moreReceiptsHref ? (
            <p className="pdpp-caption mt-2">
              <a className="text-muted-foreground underline underline-offset-2" href={moreReceiptsHref}>
                show more receipts →
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
      {unaccounted.length > 0 ? (
        <div className={showRejected ? "mt-4" : undefined}>
          <h3 className="pdpp-eyebrow">Unaccounted records</h3>
          <p className="pdpp-caption text-muted-foreground">
            The connector reported records it could not account for. It reports counts only, so which records is not
            known.
          </p>
          <ul className="mt-2 space-y-2">
            {unaccounted.map(([stream, count]) => (
              <li className="rounded-md border border-border/70 bg-background/70 px-3 py-2" key={stream}>
                <div className="pdpp-caption flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-muted-foreground">stream</span>
                  <code>{stream}</code>
                  <span className="text-foreground">{plural(count, "unaccounted record")}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
