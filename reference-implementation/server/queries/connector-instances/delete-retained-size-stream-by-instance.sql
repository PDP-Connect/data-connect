-- @terminator: exec
-- Erase one connection's per-stream retained-size projection rows as part of
-- the connection-delete cascade.
DELETE FROM retained_size_stream WHERE connector_instance_id = ?
