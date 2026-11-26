// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type {RefConnectorSummary,RefConnectorIdentitySummary} from "../lib/ref-client.ts";
import {isOwnerRecordKind} from "../lib/source-record-label.ts";
import {sourceKindLine} from "../lib/source-kind-line.ts";
import {sourceAnswer} from "../lib/source-status-words.ts";
import type {HistorySource} from "./source-names.ts";
const FINAL_STOP = /\.$/;
/** History keeps the past event and the present answer as separate facts. */
export function currentSourceWords(row:RefConnectorSummary,source:HistorySource,_sources:HistorySource[],offset?:number,now=new Date()) {
  const answer=sourceAnswer(row,{now,offset});
  return {currentKinds:Object.fromEntries(row.streams.filter(kind=>isOwnerRecordKind(kind,row.connector_id)).map(kind=>[kind,sourceKindLine(row,kind)])),currentAnswer:answer,currentProblem:answer.problem,
    currentState:`Now: ${answer.words.replace(FINAL_STOP,"")}.${answer.action ? ` See ${source.name} for the next step.` : ""}`};
}
export function applyCurrentSourceWords(rows:(RefConnectorSummary|RefConnectorIdentitySummary)[],sources:HistorySource[],offset?:number) {
  const now=new Date();
  for(const row of rows) {
    if(!("connection_health" in row)) { continue; }
    const source=sources.find(candidate=>candidate.id===(row.connector_instance_id || row.connection_id));
    if(source) { Object.assign(source,currentSourceWords(row,source,sources,offset,now)); }
  }
}
