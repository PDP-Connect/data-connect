import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceRecordCount, sourceStreamRecordCount } from "./source-record-count.ts";

test("positive held evidence defeats a conflicting empty summary without replacing positive canonical counts", () => {
  const stream = { stream: "messages", record_count: 0, retained_record_count: 42, count_state: "known_zero" as const, last_updated: null };
  assert.equal(sourceStreamRecordCount(stream), 42);
  assert.deepEqual(sourceRecordCount({ total_records: 0, total_records_state: "known_zero", stream_records: [stream] }), { count: 42, state: "known", conflicting: true });
  assert.equal(sourceStreamRecordCount({ ...stream, record_count: 3, count_state: "known" }), 3);
  assert.equal(sourceStreamRecordCount({ ...stream, retained_record_count: 0 }), 0);
});
