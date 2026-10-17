-- @terminator: one
SELECT rowid, input_identity FROM semantic_search_rowid
WHERE connector_instance_id = ? AND scope_key = ? AND record_key = ?
