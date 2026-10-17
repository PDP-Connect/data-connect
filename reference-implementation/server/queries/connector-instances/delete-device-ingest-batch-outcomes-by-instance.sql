-- @terminator: exec
-- Erase one connection's device ingest batch outcomes as part of the
-- connection-delete cascade, so a re-added connection with the same id does not
-- replay a deleted connection's accepted batches. Legacy rows with an empty
-- connector_instance_id are not matched.
DELETE FROM device_ingest_batch_outcomes WHERE connector_instance_id = ?
