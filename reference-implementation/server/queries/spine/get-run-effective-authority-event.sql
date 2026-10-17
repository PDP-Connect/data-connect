-- @terminator: one
-- Read the durable pre-spawn record, independent of timeline windows.
SELECT event_type, status, data_json, occurred_at, trace_id, actor_id
FROM spine_events
WHERE run_id = ? AND event_type = 'run.effective_authority'
ORDER BY event_seq DESC
LIMIT 1
