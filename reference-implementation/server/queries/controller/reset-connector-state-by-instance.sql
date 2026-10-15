-- @terminator: exec
-- Reset ordinary stream cursors while retaining the owner-declared collection boundary.
DELETE FROM connector_state
WHERE connector_instance_id = ?
  AND stream <> '$collection_scope'
