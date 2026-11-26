// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type {RefConnectorSummary,RefConnectorIdentitySummary} from "../lib/ref-client.ts";
import {sourceStatusWords} from "../lib/source-status-words.ts";
import {historyKindName,type HistorySource} from "./source-names.ts";
/** Current history uses the passport's report and the shared status vocabulary. */
export function currentSourceWords(row:RefConnectorSummary,source:HistorySource,sources:HistorySource[]) {
  const words=sourceStatusWords(row,{now:new Date()});
  const gaps=row.collection_report?.filter(entry=>["retryable_gap","terminal_gap","gaps","partial"].includes(entry.coverage_condition)) ?? [];
  const missing=gaps.map(entry=>historyKindName(sources,source.id,entry.stream));
  return {currentProblem:missing.length>0 || words.row <= 16 || words.row >= 22 || words.tone==="attention" || words.needsYou || row.last_run?.status==="failed",
    currentState:`${missing.length ? `${missing.join(", ")} didn't come.` : words.words} See ${source.name} for the next step.`};
}

export function applyCurrentSourceWords(rows: (RefConnectorSummary|RefConnectorIdentitySummary)[], sources:HistorySource[]) {
  for(const row of rows) {
    if(!("connection_health" in row)) {continue;}
    const source=sources.find(candidate=>candidate.id===(row.connector_instance_id || row.connection_id));
    if(source) {Object.assign(source,currentSourceWords(row,source,sources));}
  }
}
