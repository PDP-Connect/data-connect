-- @terminator: one
-- Read the current max_version for a (connector_instance_id, stream) pair so
-- the next ingest/delete can advance to (max_version + 1). Returns null
-- the first time records are ingested into the stream. `changes_floor` is the
-- oldest changes_since watermark whose delta can still be reconstructed.
SELECT max_version, changes_floor
FROM version_counter
WHERE connector_instance_id = ? AND stream = ?
