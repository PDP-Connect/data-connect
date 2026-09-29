-- @terminator: exec
-- Erase one connection's retained-size projection row as part of the
-- connection-delete cascade. The post-commit teardown marks the global
-- projection dirty; this removes the per-connection row outright.
DELETE FROM retained_size_connection WHERE connector_instance_id = ?
