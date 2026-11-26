// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { formatConnectorKeyForDisplay } from "@pdpp/display";
export interface HistorySource { id: string; connector: string; name: string }
export function sourceName(sources: HistorySource[], id: string | null, connector?: string | null): string {
  const known = sources.find(source => source.id === id)?.name;
  if (known) return known;
  const service = connector ?? sources.find(source=>source.connector===id)?.connector;
  if (service) { const label = formatConnectorKeyForDisplay(service); return `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}`; }
  return "Data source";
}
