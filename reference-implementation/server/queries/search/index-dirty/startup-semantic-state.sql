-- @terminator: one
-- Whether the connector still holds semantic index state (meta, progress or
-- vectors) for any instance. Startup uses it to owe a cleanup ticket when the
-- manifest no longer declares semantic fields but the backend is unavailable.
SELECT EXISTS (
  SELECT 1 FROM semantic_search_meta WHERE connector_id = ?
  UNION ALL SELECT 1 FROM semantic_search_backfill_progress WHERE connector_id = ?
  UNION ALL SELECT 1 FROM semantic_search_blob WHERE connector_id = ?
  UNION ALL SELECT 1 FROM semantic_search_rowid WHERE connector_id = ?
) AS present
