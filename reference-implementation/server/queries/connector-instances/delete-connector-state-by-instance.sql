-- @terminator: exec
-- Erase one connection's Collection Profile cursor rows as part of the
-- connection-delete cascade, in the same transaction as the row removal. A
-- re-added connection with the same (deterministic default-account) id then
-- starts with no cursor and backfills from scratch.
DELETE FROM connector_state WHERE connector_instance_id = ?
