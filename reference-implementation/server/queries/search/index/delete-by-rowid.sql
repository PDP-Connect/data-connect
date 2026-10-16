-- @terminator: exec
DELETE FROM lexical_search_index
WHERE rowid = ?
  AND connector_instance_id = ?
  AND stream = ?
  AND record_key = ?
  AND field = ?
  AND text = ?
