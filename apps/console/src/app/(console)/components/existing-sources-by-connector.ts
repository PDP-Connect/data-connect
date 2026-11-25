// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Exact existing sources from the owner-scoped retained-count feed. */
import {
  CONNECTOR_SUMMARY_PAGE_LIMIT_MAX,
  listConnectorSummaries,
  type RefConnectorRetainedCountSummary,
} from "../lib/ref-client.ts";
import { connectionDisplayName } from "../lib/connection-display-name.ts";
import type { ExistingSourceSetupLink, UncataloguedSourceSetupLink } from "./existing-source-links.ts";

function latestImportFacts(coverage: RefConnectorRetainedCountSummary["acquisition_coverage"]): {
  file: string | null;
  status: string | null;
} {
  const batch = coverage?.latest_batch ?? null;
  return {
    file: batch?.uploaded_file_name ?? null,
    status: batch?.status ?? null,
  };
}

function toExistingSourceSetupLink(row: RefConnectorRetainedCountSummary): ExistingSourceSetupLink {
  const importFacts = latestImportFacts(row.acquisition_coverage);
  return {
    connectionId: row.connector_instance_id,
    displayName: connectionDisplayName(row.display_name, row.connector_display_name, row.connector_id),
    latestImportFile: importFacts.file,
    latestImportStatus: importFacts.status,
    status: row.status,
    totalRecords: row.total_records,
    totalRecordsState: row.total_records_state,
  };
}

function isLive(row: RefConnectorRetainedCountSummary): boolean {
  return row.status !== "revoked" && !row.revoked_at;
}

/**
 * The reference refuses a page when the next request could not be sent back
 * (typed 400), and a proxy in front of it can answer 431 for the same reason.
 * Both mean "the rows so far are real; the rest cannot be reached".
 */
function isContinuationRefusal(err: unknown): boolean {
  if (!(err && typeof err === "object" && "status" in err)) {
    return false;
  }
  const { message, status } = err as { message?: unknown; status?: unknown };
  return status === 431 || (status === 400 && typeof message === "string" && message.includes("too large to page"));
}

interface RetainedCountSummaries {
  readonly rows: readonly RefConnectorRetainedCountSummary[];
  /** True when a page was refused and the rows are the pages read before it. */
  readonly truncated: boolean;
}

async function fetchRetainedCountSummaries(
  connectorId?: readonly string[],
  options: { readonly tolerateRefusal?: boolean } = {}
): Promise<RetainedCountSummaries> {
  const rows = new Map<string, RefConnectorRetainedCountSummary>();
  let cursor: string | undefined;
  for (;;) {
    const request = () =>
      listConnectorSummaries({
        connectorId,
        cursor,
        limit: CONNECTOR_SUMMARY_PAGE_LIMIT_MAX,
        profile: "retained_count_summary",
      });
    let page: Awaited<ReturnType<typeof request>>;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: continuation depends on the previous response.
      page = await request();
    } catch (err) {
      if (options.tolerateRefusal && isContinuationRefusal(err)) {
        return { rows: [...rows.values()], truncated: true };
      }
      throw err;
    }
    for (const row of page.data) {
      rows.set(row.connector_instance_id, row);
    }
    if (!page.has_more) {
      return { rows: [...rows.values()], truncated: false };
    }
    if (!page.next_cursor || page.next_cursor === cursor) {
      throw new Error("Connector summary feed is missing a continuation cursor");
    }
    cursor = page.next_cursor;
  }
}

/**
 * Fetch the exact set of existing (non-revoked) sources for ONE connector.
 * Sorted by display name, matching the prior stopgap's presentation order.
 */
export async function existingSourcesForConnector(connectorId: string): Promise<ExistingSourceSetupLink[]> {
  const { rows } = await fetchRetainedCountSummaries([connectorId]);
  const links = rows.filter(isLive).map(toExistingSourceSetupLink);
  return links.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export interface ExistingSourcesByConnectorCatalog {
  readonly byConnector: Record<string, readonly ExistingSourceSetupLink[]>;
  /**
   * True when the feed refused a page, so some existing sources are missing
   * from `byConnector`. The Sources > Add page still renders its catalog and
   * says so, rather than failing the whole page.
   */
  readonly truncated: boolean;
  readonly uncataloguedSources: readonly UncataloguedSourceSetupLink[];
}

/** Traverse the owner feed once, then select the requested catalog identities. */
export async function existingSourcesByConnectorCatalog(
  connectorIds: readonly string[]
): Promise<ExistingSourcesByConnectorCatalog> {
  if (connectorIds.length === 0) {
    return { byConnector: {}, truncated: false, uncataloguedSources: [] };
  }
  const catalog = new Set(connectorIds);
  const { rows, truncated } = await fetchRetainedCountSummaries(undefined, { tolerateRefusal: true });
  const byConnector: Record<string, ExistingSourceSetupLink[]> = {};
  const uncataloguedSources: UncataloguedSourceSetupLink[] = [];
  for (const row of rows) {
    if (!isLive(row)) {
      continue;
    }
    if (!catalog.has(row.connector_id)) {
      uncataloguedSources.push({
        connectorId: row.connector_id,
        connectionId: row.connector_instance_id,
        displayName: connectionDisplayName(row.display_name, row.connector_display_name, row.connector_id),
      });
      continue;
    }
    const existing = byConnector[row.connector_id];
    if (existing) {
      existing.push(toExistingSourceSetupLink(row));
    } else {
      byConnector[row.connector_id] = [toExistingSourceSetupLink(row)];
    }
  }
  for (const connectorId of Object.keys(byConnector)) {
    byConnector[connectorId] = (byConnector[connectorId] as ExistingSourceSetupLink[]).sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    );
  }
  uncataloguedSources.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { byConnector, truncated, uncataloguedSources };
}
