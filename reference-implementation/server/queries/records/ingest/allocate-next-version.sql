-- @terminator: exec_one
-- Atomically allocate the next stream version for a (connector_instance_id, stream)
-- pair. Bind order is (connector_id, connector_instance_id, stream,
-- connector_instance_id, stream, connector_instance_id, stream).
-- The new version is MAX(counter, newest history version, newest current
-- version) + 1, with absent values as 0, so an empty stream starts at 1 and a
-- counter left behind the data (partial restore, manual edit) heals instead of
-- colliding on the record_changes primary key. Postgres does the same in
-- allocateNextVersion (postgres-records.ts). Both MAX lookups use indexes:
-- record_changes PRIMARY KEY(connector_instance_id, stream, version) and
-- idx_records_version (db.ts).
-- Returns the freshly-allocated max_version as a single row via SQL
-- RETURNING, so callers never read the counter and write it separately.
-- The terminator is exec_one (mutation-returning-one), not one (pure read);
-- this keeps the registry honest about the fact that the statement mutates
-- `version_counter`. Collapses the old read-then-write pattern into one
-- durable statement that is safe for any writer model (SQLite serial
-- writers today; PostgreSQL-compatible adapters in the future).
INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
VALUES(?, ?, ?, MAX(
  0,
  COALESCE((SELECT MAX(version) FROM record_changes
            WHERE connector_instance_id = ? AND stream = ?), 0),
  COALESCE((SELECT MAX(version) FROM records
            WHERE connector_instance_id = ? AND stream = ?), 0)
) + 1)
ON CONFLICT(connector_instance_id, stream) DO UPDATE
  SET max_version = MAX(
    version_counter.max_version,
    COALESCE((SELECT MAX(version) FROM record_changes
              WHERE connector_instance_id = version_counter.connector_instance_id
                AND stream = version_counter.stream), 0),
    COALESCE((SELECT MAX(version) FROM records
              WHERE connector_instance_id = version_counter.connector_instance_id
                AND stream = version_counter.stream), 0)
  ) + 1
RETURNING max_version
