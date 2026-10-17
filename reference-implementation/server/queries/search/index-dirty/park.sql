-- @terminator: exec
UPDATE search_index_dirty
SET operator_parked = 1, revision = revision + 1
WHERE connector_instance_id = ? AND stream = ? AND dirty <> 0
