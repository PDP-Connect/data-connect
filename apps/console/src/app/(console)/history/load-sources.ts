// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { applyCurrentSourceWords } from "./current-source-words.ts";
import { connectionNameDisambiguators, connectionDisplayName } from "../lib/connection-display-name.ts";
import { findManifestForConnectorId } from "../sources/lib/relationships.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import { listConnectorSummaries } from "../lib/ref-client.ts";
import type { HistorySource } from "./source-names.ts";
export { sourceName, type HistorySource } from "./source-names.ts";
export async function loadHistorySources(current = false, offset?:number): Promise<HistorySource[]> {
  const sources: HistorySource[] = [];
  const allRows: (import("../lib/ref-client.ts").RefConnectorSummary|import("../lib/ref-client.ts").RefConnectorIdentitySummary)[] = [];
  const manifests = await listConnectorManifests().catch(()=>[]);
  let cursor: string | undefined;
  do {
    const page = current
      ? await listConnectorSummaries({ sourcesVisibility:true, limit:100, ...(cursor ? {cursor} : {}) })
      : await listConnectorSummaries({ profile: "identity_inventory", limit:100, ...(cursor ? {cursor} : {}) });
    allRows.push(...page.data);
    sources.push(...page.data.map(row => ({ id: row.connector_instance_id || row.connection_id, connector: row.connector_id,
      name: connectionDisplayName(row.display_name, row.connector_display_name, row.connector_id), serviceName:row.connector_display_name ?? findManifestForConnectorId(manifests,row.connector_id)?.display_name, kinds: findManifestForConnectorId(manifests,row.connector_id)?.streams })));
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor);
  const disambiguators=connectionNameDisambiguators(allRows);
  for(const source of sources){const row=allRows.find(candidate=>(candidate.connector_instance_id||candidate.connection_id)===source.id);if(row) { source.name=connectionDisplayName(row.display_name,row.connector_display_name,row.connector_id,disambiguators.get(row.connection_id)); }}
  if(current) { applyCurrentSourceWords(allRows,sources,offset); }
  return sources;
}
