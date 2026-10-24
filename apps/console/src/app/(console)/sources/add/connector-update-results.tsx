// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  ConnectorUpdateBatch,
  ConnectorUpdateBatchItem,
  ConnectorUpdatePlanItem,
} from "../../lib/connector-update-contract.ts";
import { connectorDisplayName, reasonLabel } from "./connector-update-review.tsx";

export const TERMINAL_ITEM_STATES = new Set([
  "succeeded",
  "deferred",
  "skipped",
  "needs_review",
  "failed",
  "rolled_back",
  "recovery_required",
]);
export const TERMINAL_BATCH_STATES = new Set(["completed", "completed_with_issues", "failed", "cancelled"]);

function versionLabel(version: string | null): string {
  return version ? `v${version}` : "the installed version";
}

function itemOutcome(item: ConnectorUpdateBatchItem): string {
  switch (item.state) {
    case "succeeded":
      return `Updated to ${versionLabel(item.target.version)}`;
    case "waiting_for_run_boundary":
    case "deferred":
      return `Waiting for an active run to finish · Still using ${versionLabel(item.installed.version)}`;
    case "needs_review":
      return `Needs review · Still using ${versionLabel(item.installed.version)}`;
    case "failed":
    case "rolled_back":
      return `Failed${item.error ? `: ${item.error}` : ""} · Still using ${versionLabel(item.installed.version)}`;
    case "recovery_required":
      return `Recovery required${item.error ? `: ${item.error}` : ""}`;
    default:
      return item.state === "queued" ? "Queued" : "Updating…";
  }
}

export function BatchResults({
  batch,
  reviewItems = [],
}: {
  batch: ConnectorUpdateBatch;
  reviewItems?: readonly ConnectorUpdatePlanItem[];
}) {
  const completed = batch.items.filter((item) => TERMINAL_ITEM_STATES.has(item.state)).length;
  const actionNeeded =
    reviewItems.length > 0 ||
    batch.items.some((item) => ["failed", "needs_review", "recovery_required", "rolled_back"].includes(item.state));
  let heading = "Updating connectors";
  if (TERMINAL_BATCH_STATES.has(batch.state)) {
    heading = "Connector update results";
  }
  return (
    <section aria-label="Connector update results" className="mb-6 border-border/80 border-b pb-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="pdpp-body font-semibold text-foreground">{heading}</h2>
        <span className="pdpp-caption text-muted-foreground tabular-nums" role="status">
          {completed} of {batch.items.length} complete
        </span>
      </div>
      <div
        aria-label="Connector update progress"
        aria-valuemax={batch.items.length}
        aria-valuemin={0}
        aria-valuenow={completed}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div
          className="h-full bg-primary transition-[width]"
          style={{ width: `${batch.items.length ? (completed / batch.items.length) * 100 : 0}%` }}
        />
      </div>
      {actionNeeded ? (
        <p className="pdpp-caption mt-3 text-destructive" role="alert">
          Some connector updates need attention. Review the results below.
        </p>
      ) : null}
      <details className="mt-3" open>
        <summary className="pdpp-caption cursor-pointer text-foreground underline underline-offset-4">
          View per-connector results
        </summary>
        <ul className="mt-2 divide-y divide-border/60">
          {batch.items.map((item) => (
            <li className="pdpp-caption flex flex-wrap justify-between gap-x-4 gap-y-1 py-2" key={item.connector_id}>
              <span className="font-medium text-foreground">{connectorDisplayName(item)}</span>
              <span
                className={
                  item.state === "failed" || item.state === "recovery_required"
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {itemOutcome(item)}
              </span>
            </li>
          ))}
          {reviewItems.map((item) => (
            <li className="pdpp-caption flex flex-wrap justify-between gap-x-4 gap-y-1 py-2" key={item.connector_id}>
              <span className="font-medium text-foreground">{connectorDisplayName(item)}</span>
              <span className="text-status-warning-fg">
                Needs review · Still using {versionLabel(item.installed.version)}
                {item.reasons.length ? ` · ${item.reasons.map(reasonLabel).join(", ")}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
