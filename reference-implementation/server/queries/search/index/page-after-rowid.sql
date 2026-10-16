-- @terminator: many
-- @cursor_field: rowid
SELECT rowid, record_key, field
FROM lexical_search_index
WHERE connector_instance_id = ?
  AND stream = ?
  AND rowid > ?
ORDER BY rowid
LIMIT ?
