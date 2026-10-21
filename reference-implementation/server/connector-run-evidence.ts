// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector run evidence and refresh-policy projection.
 *
 * Scope: owns connector run-summary lookups and manifest refresh-policy reads
 * used by schema/freshness projection and scheduler admission. It does not own
 * scheduler state, route mounting, or record visibility.
 *
 * Invariant: no import from index.js; this leaf imports spine reads directly.
 */

import { getRunTerminalEvent, listSpineCorrelations } from "../lib/spine.ts";
import { isCertifiedStreamFailureWithCommittedSiblings } from "../runtime/scheduler-backoff.ts";

export function getConnectorRunEvidenceConnectorId(storageBinding: unknown): string | null {
  const connectorId =
    storageBinding && typeof storageBinding === "object" && !Array.isArray(storageBinding)
      ? (storageBinding as { connector_id?: unknown }).connector_id
      : null;
  return typeof connectorId === "string" && connectorId ? connectorId : null;
}

export async function getLatestConnectorRunSummary(
  connectorId: string | null | undefined,
  status: string | null = null,
  connectorInstanceId: string | null | undefined = null
): Promise<{ last_at: unknown; status: unknown } | null> {
  if (!connectorId) {
    return null;
  }
  const filters = {
    limit: 1,
    sourceId: connectorId,
    sourceKind: "connector",
    ...(status ? { status } : {}),
    ...(connectorInstanceId ? { connectorInstanceId } : {}),
  };
  const { summaries } = await listSpineCorrelations("run", filters);
  const summary = summaries[0] || null;
  if (!summary) {
    return null;
  }
  return {
    last_at: summary.last_at,
    status: summary.status,
  };
}

/** How many of a connection's newest failed runs the certified-progress probe inspects. */
const CERTIFIED_PROGRESS_PROBE_WINDOW = 16;

/**
 * Epoch ms of the newest run of a connection, on any trigger path, that the
 * runtime recorded as certified partial progress: it ended failed with
 * `stream_collection_failed` while sibling streams committed
 * (`isCertifiedStreamFailureWithCommittedSiblings`). Read from the durable
 * spine, so it sees manual `controller.runNow` runs that the scheduler's own
 * history never holds, and it survives a restart. The facts come from the
 * runtime-authored terminal event (`connector_error_code`,
 * `checkpoint_commit_status`), never from connector output.
 *
 * This is back-off recovery evidence only. It is not a success: it never feeds
 * `last_successful_at` or `CollectionSucceeded`. Returns `null` when none of
 * the newest failed runs qualifies.
 */
export async function getLatestCertifiedProgressRunAt(
  connectorId: string | null | undefined,
  connectorInstanceId: string | null | undefined = null
): Promise<number | null> {
  if (!connectorId) {
    return null;
  }
  const { summaries } = await listSpineCorrelations("run", {
    limit: CERTIFIED_PROGRESS_PROBE_WINDOW,
    sourceId: connectorId,
    sourceKind: "connector",
    status: "failed",
    ...(connectorInstanceId ? { connectorInstanceId } : {}),
  });
  for (const summary of summaries) {
    if (!summary.id) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: newest first; stop at the first qualifying run.
    const terminal = await getRunTerminalEvent(summary.id);
    const data =
      terminal?.data && typeof terminal.data === "object" ? (terminal.data as Record<string, unknown>) : null;
    if (
      data &&
      isCertifiedStreamFailureWithCommittedSiblings({
        checkpointSummary:
          typeof data.checkpoint_commit_status === "string" ? { commit_status: data.checkpoint_commit_status } : null,
        connectorError: typeof data.connector_error_code === "string" ? { code: data.connector_error_code } : null,
        status: "failed",
      })
    ) {
      const at = Date.parse(String(summary.last_at));
      return Number.isFinite(at) ? at : null;
    }
  }
  return null;
}

export function getManifestRefreshPolicy(manifest: { capabilities?: unknown } | null | undefined): unknown {
  const capabilities = manifest?.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }
  return (capabilities as Record<string, unknown>).refresh_policy ?? null;
}

export function getMaximumStalenessSeconds(refreshPolicy: unknown): number | null {
  if (!refreshPolicy || typeof refreshPolicy !== "object" || Array.isArray(refreshPolicy)) {
    return null;
  }
  const value = (refreshPolicy as Record<string, unknown>).maximum_staleness_seconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
