// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type {RefConnectorSummary,RefConnectorIdentitySummary} from "../lib/ref-client.ts";
import {sourceAnswer} from "../lib/source-status-words.ts";
import type {HistorySource} from "./source-names.ts";
/** History keeps the past event and the present answer as separate facts. */
export function currentSourceWords(row:RefConnectorSummary,source:HistorySource,_sources:HistorySource[],offset?:number) {
  const answer=sourceAnswer(row,{now:new Date(),offset});
  return {currentAnswer:answer,currentProblem:answer.problem,
    currentState:`Now: ${answer.words.replace(/\.$/,"")}.${answer.action ? ` See ${source.name} for the next step.` : ""}`};
}
export function applyCurrentSourceWords(rows:(RefConnectorSummary|RefConnectorIdentitySummary)[],sources:HistorySource[],offset?:number) {
  for(const row of rows) {
    if(!("connection_health" in row)) continue;
    const source=sources.find(candidate=>candidate.id===(row.connector_instance_id || row.connection_id));
    if(source) Object.assign(source,currentSourceWords(row,source,sources,offset));
  }
}
