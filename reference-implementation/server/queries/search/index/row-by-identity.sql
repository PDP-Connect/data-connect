-- @terminator: one
SELECT rowid, record_key, field, text
FROM lexical_search_index
WHERE rowid = ?
  AND connector_instance_id = ?
  AND stream = ?
  AND record_key = ?
  AND field = ?
