// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type {RefConnectorSummary} from "./ref-client.ts";
import {sourceStreamRecordCount} from "./source-record-count.ts";
/** A held count is distinct from records copied by one attempt (which may repeat records). */
export function sourceKindLine(source:Pick<RefConnectorSummary,"stream_records"|"collection_report"|"last_run">,kind:string) {
  const record=source.stream_records?.find(row=>row.stream===kind);
  const report=source.collection_report?.find(row=>row.stream===kind);
  const count=record ? sourceStreamRecordCount(record) : null;
  const copied=typeof report?.collected === "number" ? report.collected : 0;
  const knownCount=count !== null && count > 0 ? count : copied > 0 ? copied : count ?? 0;
  const missing=Boolean(report && ["retryable_gap","terminal_gap","gaps","partial"].includes(report.coverage_condition)) || Boolean(source.last_run?.known_gaps?.some(gap=>typeof gap === "object" && gap !== null && "stream" in gap && gap.stream===kind));
  const line=knownCount>0 ? `${knownCount.toLocaleString("en-US")}${missing ? " so far. Some didn't come at the last sync." : ""}` : missing ? "Didn't come at the last sync." : "None yet";
  return {count:knownCount,line,missing};
}
