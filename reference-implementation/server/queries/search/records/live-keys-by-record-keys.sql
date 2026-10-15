-- @terminator: many
-- @cursor_field: record_key
SELECT record_key
FROM records
WHERE connector_instance_id = ?
  AND stream = ?
  AND deleted = 0
  AND record_key IN (SELECT value FROM json_each(?))
ORDER BY record_key
LIMIT ?
