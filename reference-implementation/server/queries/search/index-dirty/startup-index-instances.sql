-- @terminator: iterate
-- @cursor_field: connector_instance_id
-- Every instance that holds records or search-index state for a connector, so
-- a failed startup backfill queues state it would have repaired or cleaned up
-- even when no active binding names the instance. An instance with neither
-- records nor index state has nothing to repair and needs no ticket.
SELECT connector_instance_id FROM records WHERE connector_id = ?
UNION SELECT connector_instance_id FROM lexical_search_meta WHERE connector_id = ?
UNION SELECT connector_instance_id FROM lexical_search_index WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_meta WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_backfill_progress WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_blob WHERE connector_id = ?
UNION SELECT connector_instance_id FROM semantic_search_rowid WHERE connector_id = ?
