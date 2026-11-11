-- @terminator: many
-- @cursor_field: stream
-- Enumerate a bounded page of distinct blob binding tuples within one
-- connector instance. The composite cursor is (stream, record_key).
SELECT 0 AS id, connector_id, connector_instance_id, stream, record_key
FROM (
  SELECT connector_id, connector_instance_id, stream, record_key
  FROM blob_bindings
  WHERE blob_id = ?
  UNION
  SELECT connector_id, connector_instance_id, stream, record_key
  FROM blobs
  WHERE blob_id = ?
) bindings
WHERE connector_id = ?
  AND connector_instance_id = ?
  AND (
    ? = 0
    OR stream COLLATE BINARY > ?
    OR (stream COLLATE BINARY = ? AND record_key COLLATE BINARY > ?)
  )
ORDER BY stream COLLATE BINARY, record_key COLLATE BINARY
LIMIT ?
