-- @terminator: one
-- Whole-run record outcomes, summed in the database over every event of the
-- run, independent of any timeline page. Returns exactly one row:
--   rejected_in_batches  sum of `records_permanently_rejected` over
--                        `run.batch_ingested` events that report it
--   unreported_batches   `run.batch_ingested` events with no such count
--                        (events written before the field existed)
--   unaccounted_json     JSON object { stream: unaccounted }, summed over the
--                        stream's `run.stream_evidence_declared` events,
--                        streams with a positive count only
-- Postgres mirror: `postgresGetRunRecordOutcomes` in lib/postgres-spine.ts.
WITH batches AS (
  SELECT
    COALESCE(SUM(CASE WHEN json_type(data_json, '$.records_permanently_rejected') = 'integer'
                      THEN json_extract(data_json, '$.records_permanently_rejected') ELSE 0 END), 0) AS rejected_in_batches,
    COALESCE(SUM(CASE WHEN json_type(data_json, '$.records_permanently_rejected') = 'integer'
                      THEN 0 ELSE 1 END), 0) AS unreported_batches
  FROM spine_events
  WHERE run_id = ?
    AND event_type = 'run.batch_ingested'
),
evidence AS (
  SELECT stream_id,
         SUM(CASE WHEN json_type(data_json, '$.outcomes.unaccounted') = 'integer'
                  THEN json_extract(data_json, '$.outcomes.unaccounted') ELSE 0 END) AS unaccounted
  FROM spine_events
  WHERE run_id = ?
    AND event_type = 'run.stream_evidence_declared'
    AND stream_id IS NOT NULL
  GROUP BY stream_id
  HAVING unaccounted > 0
)
SELECT rejected_in_batches,
       unreported_batches,
       (SELECT json_group_object(stream_id, unaccounted) FROM evidence) AS unaccounted_json
FROM batches
