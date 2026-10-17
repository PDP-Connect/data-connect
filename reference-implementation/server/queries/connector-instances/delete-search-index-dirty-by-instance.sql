-- @terminator: exec
-- Erase one connection's search-index dirty scopes as part of the
-- connection-delete cascade, so reconcile does not chase a deleted connection
-- and a re-added connection with the same id starts without stale backoff.
DELETE FROM search_index_dirty WHERE connector_instance_id = ?
