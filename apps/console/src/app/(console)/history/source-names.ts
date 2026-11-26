// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { canonicalConnectorKey } from "pdpp-reference-implementation/connection-setup-plan";
import { formatConnectorKeyForDisplay, humanizeFieldLabel, streamDisplayLabel } from "@pdpp/display";
import { connectionDisplayName } from "../lib/connection-display-name.ts";
export interface HistorySource { currentState?: string; currentProblem?: boolean; id: string; connector: string; name: string; serviceName?:string; kinds?: { name:string; display?: {label?:string} }[] }
export function sourceName(sources: HistorySource[], id: string | null, connector?: string | null): string {
  const known = sources.find(source => source.id === id)?.name;
  if (known) { return known; }
  const service = connector ?? sources.find(source=>canonicalConnectorKey(source.connector).replaceAll("_","-")===canonicalConnectorKey(id ?? "").replaceAll("_","-"))?.connector;
  if (service) { return connectionDisplayName(null,sources.find(source=>canonicalConnectorKey(source.connector).replaceAll("_","-")===canonicalConnectorKey(service).replaceAll("_","-"))?.serviceName ?? formatConnectorKeyForDisplay(formatConnectorKeyForDisplay(canonicalConnectorKey(service))),service); }
  return "Data source";
}

export function historyKindName(sources: HistorySource[], id: string | null, kind: string | null): string {
  if (!kind) { return "records"; }
  const entry = sources.find(source=>source.id===id || canonicalConnectorKey(source.connector).replaceAll("_","-")===canonicalConnectorKey(id ?? "").replaceAll("_","-"))?.kinds?.find(entry=>entry.name===kind);
  const label = streamDisplayLabel(kind,entry);
  return label === kind ? humanizeFieldLabel(kind) : label;
}
