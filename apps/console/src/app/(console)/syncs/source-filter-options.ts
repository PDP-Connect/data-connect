// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { CONNECTOR_SUMMARY_PAGE_SIZE } from "../components/connector-summary-page.tsx";

interface SourceFilterItem {
  connector_display_name?: string;
  connector_id: string;
}

type SourceFilterPage<T> =
  | { kind: "error" }
  | { hasMore: boolean; items: readonly T[]; kind: "ok"; nextCursor?: string };

// Each server page holds up to CONNECTOR_SUMMARY_PAGE_SIZE (100) data sources, so
// this cap lists up to 1,000. The walk reruns on every History load, including the
// 3-second refresh while a sync is live, so it stays small: at most 9 extra reads.
export const SOURCE_FILTER_MAX_PAGES = 10;

export const SOURCE_FILTER_CAP_NOTE = `Only the first ${(SOURCE_FILTER_MAX_PAGES * CONNECTOR_SUMMARY_PAGE_SIZE).toLocaleString("en-US")} data sources are listed here.`;

export async function loadSourceFilterOptions<T extends SourceFilterItem>(
  firstPage: SourceFilterPage<T>,
  loadPage: (cursor: string) => Promise<SourceFilterPage<T>>,
  activeConnectorId: string | undefined
): Promise<{ note: string | null; options: { label: string; value: string }[] }> {
  const connectors: T[] = [];
  let page = firstPage;
  let pagesLoaded = 0;
  let note: string | null = page.kind === "error" ? "Some data sources could not be loaded for this filter." : null;

  while (page.kind === "ok") {
    connectors.push(...page.items);
    pagesLoaded += 1;
    if (!page.hasMore) {
      break;
    }
    if (!page.nextCursor || pagesLoaded >= SOURCE_FILTER_MAX_PAGES) {
      note = SOURCE_FILTER_CAP_NOTE;
      break;
    }

    try {
      // The next cursor is returned by this page, so the server requests must stay sequential.
      page = await loadPage(page.nextCursor);
    } catch {
      note = "Some data sources could not be loaded for this filter.";
      break;
    }
    if (page.kind === "error") {
      note = "Some data sources could not be loaded for this filter.";
      break;
    }
  }

  const byConnectorId = new Map<string, string>();
  for (const connector of connectors) {
    if (!byConnectorId.has(connector.connector_id)) {
      byConnectorId.set(connector.connector_id, connector.connector_display_name || connector.connector_id);
    }
  }
  if (activeConnectorId && !byConnectorId.has(activeConnectorId)) {
    byConnectorId.set(activeConnectorId, activeConnectorId);
  }
  const options = [...byConnectorId.entries()]
    .map(([value, label]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    note,
    options: options.length > 0 ? [{ label: "All data sources", value: "" }, ...options] : [],
  };
}
