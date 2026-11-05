-- @terminator: iterate
-- @cursor_field: connector_instance_id
-- Instances that hold search-index state for a connector, so state the backfill
-- cleans up is still queued when no active binding names the instance. `records`
-- is left out on purpose: the semantic resolver already lists every instance
-- that has records for a manifest stream (test/startup-backfill-durable-retry),
-- so a second `records` read here would only repeat that lookup.
SELECT connector_instance_id FROM lexical_search_meta WHERE connector_id = ?
UNION SELECT connector_instance_id FROM lexical_search_index WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_meta WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_backfill_progress WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_blob WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_rowid WHERE connector_id = ?
