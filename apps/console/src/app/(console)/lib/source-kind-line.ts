// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type {RefConnectorSummary} from "./ref-client.ts";
import {sourceStreamRecordCount} from "./source-record-count.ts";
/** A held count is distinct from records copied by one attempt (which may repeat records). */
export function sourceKindLine(source:Pick<RefConnectorSummary,"stream_records"|"collection_report"|"last_run">,kind:string) {
  const record=source.stream_records?.find(row=>row.stream===kind);
  const report=source.collection_report?.find(row=>row.stream===kind);
  const count=record ? sourceStreamRecordCount(record) : null;
  const receipt=source.last_run?.collection_facts?.streams.find(row=>row.stream===kind);
  const copied=Math.max(typeof report?.collected === "number" ? report.collected : 0,receipt?.collected ?? 0);
  let knownCount=count ?? 0;
  if (knownCount === 0 && copied > 0) { knownCount=copied; }
  const missing=Boolean(report && ["retryable_gap","terminal_gap","gaps","partial"].includes(report.coverage_condition)) || Boolean(source.last_run?.known_gaps?.some(gap=>typeof gap === "object" && gap !== null && "stream" in gap && gap.stream===kind));
  let line="None yet";
  if (knownCount>0) { line=`${knownCount.toLocaleString("en-US")}${missing ? " so far. Some didn't come at the last sync." : ""}`; }
  else if(missing) { line="Didn't come at the last sync."; }
  return {count:knownCount,line,missing};
}
