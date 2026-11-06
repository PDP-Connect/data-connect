-- @terminator: iterate
-- @cursor_field: connector_instance_id
SELECT connector_instance_id FROM lexical_search_meta WHERE connector_id = ?
UNION SELECT connector_instance_id FROM lexical_search_index WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_meta WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_backfill_progress WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_blob WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_rowid WHERE connector_id = ?
