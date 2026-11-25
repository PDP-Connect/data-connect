// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  CONNECTOR_SUMMARY_PAGE_LIMIT_MAX,
  listConnectorSummaries,
  type RefConnectorRetainedCountSummary,
  type RefConnectorRetainedCountSummariesResponse,
} from "../../lib/ref-client.ts";
import type {
  ExistingSourceSetupLink,
  SourceSummaryRead,
  UncataloguedSourceSetupLink,
} from "../../components/source-setup-catalog.tsx";

function toSetupLink(row: RefConnectorRetainedCountSummary): ExistingSourceSetupLink {
  const latestBatch = row.acquisition_coverage?.latest_batch ?? null;
  return {
    connectionId: row.connector_instance_id,
    displayName: row.display_name,
    latestImportFile: latestBatch?.uploaded_file_name ?? null,
    latestImportStatus: latestBatch?.status ?? null,
    status: row.status,
    totalRecords: row.total_records,
    totalRecordsState: row.total_records_state,
  };
}

function isContinuationRefusal(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("status" in err)) return false;
  const { message, status } = err as { message?: unknown; status?: unknown };
  return status === 431 || (status === 400 && typeof message === "string" && message.includes("too large to page"));
}

export function projectInstalledSourceCatalog(
  rows: readonly RefConnectorRetainedCountSummary[],
  catalogConnectorIds: readonly string[]
): SourceSummaryRead {
  const catalogIds = new Set(catalogConnectorIds);
  const byConnector: Record<string, ExistingSourceSetupLink[]> = {};
  const uncataloguedSources: UncataloguedSourceSetupLink[] = [];

  for (const row of rows) {
    if (row.status === "revoked" || row.revoked_at) continue;
    const source = toSetupLink(row);
    const connectorSources = byConnector[row.connector_id] ?? [];
    connectorSources.push(source);
    byConnector[row.connector_id] = connectorSources;
    if (!catalogIds.has(row.connector_id)) {
      uncataloguedSources.push({
        connectorId: row.connector_id,
        connectionId: row.connector_instance_id,
        displayName: row.display_name,
      });
    }
  }

  for (const sources of Object.values(byConnector)) {
    sources.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  uncataloguedSources.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { byConnector, truncated: false, uncataloguedSources };
}

export async function readInstalledSourceCatalog(catalogConnectorIds: readonly string[]): Promise<SourceSummaryRead> {
  const rows = new Map<string, RefConnectorRetainedCountSummary>();
  let cursor: string | undefined;
  for (;;) {
    let page: RefConnectorRetainedCountSummariesResponse;
    try {
      page = await listConnectorSummaries({
        cursor,
        limit: CONNECTOR_SUMMARY_PAGE_LIMIT_MAX,
        profile: "retained_count_summary",
      });
    } catch (err) {
      if (cursor && isContinuationRefusal(err)) {
        const partial = projectInstalledSourceCatalog([...rows.values()], catalogConnectorIds);
        return { ...partial, truncated: true };
      }
      throw err;
    }
    for (const row of page.data) rows.set(row.connector_instance_id, row);
    if (!page.has_more) return projectInstalledSourceCatalog([...rows.values()], catalogConnectorIds);
    if (!page.next_cursor || page.next_cursor === cursor) {
      throw new Error("Connector summary feed is missing a continuation cursor");
    }
    cursor = page.next_cursor;
  }
}
