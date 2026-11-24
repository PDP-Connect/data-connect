-- @terminator: iterate
-- @cursor_field: stream
SELECT stream FROM records WHERE connector_instance_id = ? AND connector_id = ?
UNION SELECT stream FROM lexical_search_meta WHERE connector_instance_id = ? AND connector_id = ?
UNION SELECT stream FROM semantic_search_meta WHERE connector_instance_id = ? AND connector_id = ?
UNION SELECT stream FROM semantic_search_backfill_progress WHERE connector_instance_id = ? AND connector_id = ?
UNION SELECT stream FROM lexical_search_index WHERE connector_instance_id = ? AND connector_id = ?
UNION SELECT json_extract(scope_key, '$[0]') AS stream FROM semantic_search_blob WHERE connector_instance_id = ? AND connector_id = ? AND json_valid(scope_key) AND json_type(scope_key, '$[0]') = 'text'
UNION SELECT json_extract(scope_key, '$[0]') AS stream FROM semantic_search_rowid WHERE connector_instance_id = ? AND connector_id = ? AND json_valid(scope_key) AND json_type(scope_key, '$[0]') = 'text'
