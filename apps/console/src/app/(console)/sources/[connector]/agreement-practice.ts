// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { buildRecoveryDemoModel } from "./source-detail-demo-data.ts";
import type { SourceStatusRow } from "../../lib/source-status-words.ts";

/** Invented accounts with the stored shapes in the final agreement ledger. */
export const AGREEMENT_STATES = [
  "maintainer-failure", "schedule-off-failure", "maintainer-partial", "archived-partial",
  "zero-summary-positive-tally", "retry-partial", "retry-web", "unfinished-sign-in",
  "maintainer-unknown-kind", "maintainer-copy-failure", "device-unsent", "install-again",
] as const;
export function agreementPractice(state: string) {
  const index = (AGREEMENT_STATES as readonly string[]).indexOf(state);
  if (index < 0) return null;
  const row: SourceStatusRow = index === 3 ? 1 : index === 10 ? 8 : index === 11 ? 4 : [1,4,5,6].includes(index) ? 16 : 13;
  const model = buildRecoveryDemoModel(row, false);
  const id = `practice-agreement-${index}`;
  const kind = index === 4 ? "profile" : "messages";
  const held = index === 4 ? 1 : index === 5 ? 207 : 428;
  const failed = ![2,3,4,10,11].includes(index);
  const reason = index === 7 ? "assistance_timed_out" : index === 9 ? "stream_collection_failed" : "connector_reported_failed";
  const records = [{ stream: kind, last_updated:null, record_count: index === 4 ? 0 : held, retained_record_count: held, count_state: index === 4 ? "known_zero" as const : "known" as const }];
  const source = {
    ...model.source, connection_id: id, connector_instance_id: id, connector_id: "northwind",
    display_name: "Northwind (practice account)", connector_display_name: "Northwind",
    source_kind: index === 10 ? "local_device" as const : "account" as const,
    source_visibility: index === 3 ? "archived" as const : "active" as const,
    status: index === 3 ? "paused" : "active", streams: [kind], stream_records: records,
    total_records: index === 4 ? 0 : held, total_records_state: "known" as const,
    last_run: { ...model.source.last_run!, status: failed ? "failed" : index === 10 || index === 11 ? "skipped" : "succeeded", failure_reason: reason, terminal_reason: reason, connector_error: null },
    collection_report: [2,3,4,5,6,7,8,9].includes(index) ? [{stream:kind, checkpoint:"unknown",collected:index===4?1:index===5?442:14,considered:"unknown" as const,coverage_condition:index===4?"complete" as const:"terminal_gap" as const,forward_disposition:index===4?"complete" as const:"terminal" as const,pending_detail_gaps:0,skipped:null}] : [],
    local_device_progress: index === 10 ? {...model.source.local_device_progress!,records_pending:4_959} : null,
  };
  if (index === 1 || index === 4) source.owner_state = {...source.owner_state!,resolver:"owner_paused"};
  if (index === 10) source.owner_state = {...source.owner_state!,resolver:"needs_owner"};
  return {...model, connectionId:id,connectorInstanceId:id,connectorId:"northwind",displayName:source.display_name,
    source, latestKnownGaps:[], streams:records.map(record=>({...record,name:record.stream,object:"stream" as const,last_updated:null})),
    overview:{...model.overview,localDeviceProgress:source.local_device_progress},
  };
}
