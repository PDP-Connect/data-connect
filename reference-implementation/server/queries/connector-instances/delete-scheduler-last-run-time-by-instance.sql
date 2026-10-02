-- @terminator: exec
-- Erase one connection's scheduler cadence anchor as part of the
-- connection-delete cascade, so a re-added connection with the same id is not
-- treated as recently run.
DELETE FROM scheduler_last_run_times WHERE connector_instance_id = ?
