-- @terminator: exec
INSERT INTO search_index_dirty(connector_instance_id, connector_id, stream, dirty, marked_at, revision, operator_parked)
SELECT ?, ?, ?, 1, ?, 1, 0
WHERE NOT EXISTS (SELECT 1 FROM connector_instances WHERE connector_instance_id = ? AND connector_id <> ?)
  AND NOT EXISTS (SELECT 1 FROM connector_instance_tombstones WHERE connector_instance_id = ?)
ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
  connector_id = excluded.connector_id,
  marked_at = CASE WHEN search_index_dirty.dirty <> 0 THEN search_index_dirty.marked_at ELSE excluded.marked_at END,
  attempts = CASE WHEN search_index_dirty.dirty <> 0 OR search_index_dirty.operator_parked <> 0 THEN search_index_dirty.attempts ELSE 0 END,
  next_attempt_at = CASE WHEN search_index_dirty.dirty <> 0 OR search_index_dirty.operator_parked <> 0 THEN search_index_dirty.next_attempt_at ELSE NULL END,
  dirty = 1,
  revision = search_index_dirty.revision + 1
