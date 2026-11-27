// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RefConnectorStreamRecord, RefConnectorSummary } from "./ref-client.ts";
import { knownStreamRecordCount } from "./stream-evidence-state.ts";
import { isTotalRecordsAuthoritative } from "./total-records-label.ts";

/** Canonical positive counts win; a conflicting positive tally prevents a false empty claim. */
export function sourceStreamRecordCount(record: Pick<RefConnectorStreamRecord, "record_count" | "retained_record_count" | "count_state">): number | null {
  const canonical = knownStreamRecordCount(record);
  if (canonical !== null && canonical > 0) return canonical;
  const held = record.retained_record_count;
  return typeof held === "number" && held > 0 ? held : canonical;
}

export function sourceRecordCount(source: Pick<RefConnectorSummary, "total_records" | "total_records_state" | "stream_records">) {
  const records = source.stream_records ?? [];
  const counts = records.map(sourceStreamRecordCount);
  const held = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
  const conflicting = records.some((record) => (record.retained_record_count ?? 0) > 0 && (knownStreamRecordCount(record) ?? 0) <= 0);
  const canonical = isTotalRecordsAuthoritative(source.total_records_state) ? source.total_records : null;
  const count = conflicting ? Math.max(canonical ?? 0, held) : canonical;
  return { count, conflicting, state: count === null ? source.total_records_state : count === 0 ? "known_zero" as const : "known" as const };
}
