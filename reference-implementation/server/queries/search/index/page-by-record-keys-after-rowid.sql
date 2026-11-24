-- @terminator: many
-- @cursor_field: rowid
SELECT rowid, record_key, field, text
FROM lexical_search_index
WHERE connector_instance_id = ?
  AND stream = ?
  AND rowid > ?
  AND record_key IN (SELECT value FROM json_each(?))
ORDER BY rowid
LIMIT ?
