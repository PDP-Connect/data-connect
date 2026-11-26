// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { connectionDisplayName } from "../lib/connection-display-name.ts";
import { listConnectorSummaries } from "../lib/ref-client.ts";
export interface HistorySource { id: string; connector: string; name: string }
export async function loadHistorySources(): Promise<HistorySource[]> {
  const sources: HistorySource[] = [];
  let cursor: string | undefined;
  do {
    const page = await listConnectorSummaries({ profile: "identity_inventory", limit: 100, ...(cursor ? { cursor } : {}) });
    sources.push(...page.data.map(row => ({ id: row.connector_instance_id || row.connection_id, connector: row.connector_id,
      name: connectionDisplayName(row.display_name, row.connector_display_name, row.connector_id) })));
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor);
  return sources;
}
export function sourceName(sources: HistorySource[], id: string | null, connector?: string | null): string {
  return sources.find(source => source.id === id)?.name ?? sources.find(source => source.connector === (connector ?? id))?.name ?? "Data source";
}
