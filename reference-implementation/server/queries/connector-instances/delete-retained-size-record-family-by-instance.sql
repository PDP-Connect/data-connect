-- @terminator: exec
-- Erase one connection's per-record-family retained-size projection rows as
-- part of the connection-delete cascade.
DELETE FROM retained_size_record_family WHERE connector_instance_id = ?
