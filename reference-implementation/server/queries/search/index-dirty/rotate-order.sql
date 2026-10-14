-- @terminator: exec
-- Queue-fairness rotation: move a scope that returned `partial` behind the
-- other dirty scopes (list-dirty orders by marked_at). Touches neither
-- `revision` nor `dirty`.
UPDATE search_index_dirty
SET marked_at = ?
WHERE connector_instance_id = ? AND stream = ? AND dirty <> 0
