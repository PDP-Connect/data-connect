-- @terminator: exec
-- Make sure one scope has a dirty row with dirty = 1, WITHOUT changing
-- `revision`. Used so every scope that holds an unfinished semantic pass (or
-- was deferred by the pass budget) has a guaranteed resumer in the sweep.
-- Never touching `revision` is deliberate: revision is the CAS token of every
-- in-flight pass, and it only ever increases through mark-dirty.sql.
INSERT INTO search_index_dirty(connector_instance_id, connector_id, stream, dirty, marked_at, revision)
VALUES(?, ?, ?, 1, ?, 1)
ON CONFLICT(connector_instance_id, stream) DO UPDATE SET dirty = 1
