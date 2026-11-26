// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { connectionDisplayName } from "../lib/connection-display-name.ts";
import { findManifestForConnectorId } from "../sources/lib/relationships.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import { listConnectorSummaries } from "../lib/ref-client.ts";
import type { HistorySource } from "./source-names.ts";
export { sourceName, type HistorySource } from "./source-names.ts";
export async function loadHistorySources(): Promise<HistorySource[]> {
  const sources: HistorySource[] = [];
  const manifests = await listConnectorManifests().catch(()=>[]);
  let cursor: string | undefined;
  do {
    const page = await listConnectorSummaries({ profile: "identity_inventory", limit: 100, ...(cursor ? { cursor } : {}) });
    sources.push(...page.data.map(row => ({ id: row.connector_instance_id || row.connection_id, connector: row.connector_id,
      name: connectionDisplayName(row.display_name, row.connector_display_name, row.connector_id), serviceName:row.connector_display_name ?? findManifestForConnectorId(manifests,row.connector_id)?.display_name, kinds: findManifestForConnectorId(manifests,row.connector_id)?.streams })));
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor);
  return sources;
}
