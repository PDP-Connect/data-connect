-- @terminator: exec
-- Explicit recovery: make a dirty backed-off/parked scope eligible on the next
-- round and reset its failure streak. Preserve dirty and advance revision so
-- stale in-flight clear/failure writes cannot replace the operator action.
UPDATE search_index_dirty
SET attempts = 0, next_attempt_at = NULL, operator_parked = 0, revision = revision + 1
WHERE connector_instance_id = ? AND stream = ? AND dirty <> 0
