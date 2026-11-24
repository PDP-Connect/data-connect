-- @terminator: exec
-- Erase one connection's per-grant cursor rows as part of the connection-delete
-- cascade, in the same transaction as the row removal.
DELETE FROM grant_connector_state WHERE connector_instance_id = ?
