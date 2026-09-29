-- @terminator: exec
-- Erase one connection's summary-evidence repair resume state as part of the
-- connection-delete cascade, next to connector_summary_evidence itself.
DELETE FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = ?
