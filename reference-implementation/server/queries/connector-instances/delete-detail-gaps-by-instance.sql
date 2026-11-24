-- @terminator: exec
-- Erase one connection's detail-gap recovery queue as part of the
-- connection-delete cascade. A re-added connection with the same
-- (deterministic default-account) id must not resume the deleted source's gaps.
DELETE FROM connector_detail_gaps WHERE connector_instance_id = ?
