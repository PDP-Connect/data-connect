-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grants
-- @max_rows: 1024
-- Held-data disconnect covers ended grants too, even when the lifecycle
-- history is lost. Bound the prototype's per-client grant enumeration.
SELECT grant_id
FROM grants
WHERE client_id = ?
ORDER BY issued_at ASC
