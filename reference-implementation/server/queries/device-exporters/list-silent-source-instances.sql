-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: device_source_instances
-- @max_rows: 2048
--
-- Silent device collectors that have not been reported yet.
--
-- Silence is the detector. A local collector is a one-shot process; when it dies
-- before its first network call the server sees no failed run and no error, and
-- the only thing that changes is that `last_heartbeat_at` stops advancing. So
-- this selects on heartbeat age alone, and deliberately not on `last_error_json`
-- or any run record, both of which stay empty for exactly this failure.
--
-- The NOT EXISTS is what keeps this cheap. It excludes any instance whose CURRENT
-- silence episode the owner has already been told about or has already acted on,
-- so each tick returns only work nobody has finished. Selecting every silent
-- instance and paging over it instead needs a cursor to make progress, a place
-- to keep the cursor across restarts, a wrap rule, and agreement between the
-- caller's page size and the store's own row cap — none of which buy a
-- notification.
--
-- Handling a row usually removes it from the next tick's results, but not
-- always: a notifier that fails before handing the push over records no outcome,
-- so the row stays selected to be retried. That is deliberate, and it is why
-- LIMIT alone is NOT a complete answer to batching and why the ORDER BY below
-- does real work. An earlier version of this comment claimed a bounded batch
-- "cannot starve anything"; that is false in two distinct ways, both measured,
-- and the two ORDER BY keys exist to close them.
--
-- First: retries sorting alongside first attempts. A correlated failure — an
-- expired push credential, an unreachable endpoint, a projection outage, each of
-- which fails for every instance at once — puts as many rows into retry as the
-- batch holds, and they then fill every subsequent batch while collectors nobody
-- has heard of wait behind them. The record-count key puts never-recorded rows
-- first, so a tick always spends its budget on unreported collectors and retries
-- take what is left.
--
-- Second: retries competing with each other on a fixed order. Once every
-- instance owns a record the count key ties at 1 for all of them, and a static
-- tiebreak hands the same rows the whole batch on every tick forever — so a
-- collector that was failing and has since healed would never be tried again.
-- `updated_at` breaks that tie by how long ago a row was last attempted, oldest
-- first, and the upsert refreshes it on every attempt. A row that is tried moves
-- to the back, so the retry share rotates and every retry gets a turn within a
-- bounded number of ticks.
--
-- The episode key is the heartbeat that preceded the silence, matching the
-- attention id the writer builds. That is what distinguishes one outage from the
-- next: a collector that is fixed and later breaks again has a different last
-- heartbeat, so a different id, so this NOT EXISTS does not match and the new
-- outage is reported — while the resolved record from the old outage stays
-- resolved and is never reopened.
--
-- Two things end an episode's eligibility, and both are needed. A recorded
-- delivery outcome ends it because the owner has been told. A lifecycle other
-- than `open` ends it because the owner has acted — resolved, acknowledged,
-- cancelled — and the stage upserts a freshly-built `open` record, so a row that
-- stayed selected would silently overwrite that decision and re-announce work
-- the owner had already dismissed or taken up.
--
-- `last_heartbeat_at IS NULL` is excluded because an instance that never checked
-- in has not gone silent, it never spoke; that is unfinished enrollment, which
-- needs different copy and a different remedy. Revoked devices and non-active
-- instances are excluded because their silence is the owner's own teardown, and
-- reporting a teardown as a fault is how a notification stops being read.
SELECT dsi.source_instance_id,
       dsi.device_id,
       dsi.connector_id,
       dsi.connector_instance_id,
       dsi.last_heartbeat_at,
       dsi.last_heartbeat_status,
       dsi.records_pending
FROM device_source_instances dsi
JOIN device_exporters de ON de.device_id = dsi.device_id
WHERE dsi.last_heartbeat_at IS NOT NULL
  AND dsi.last_heartbeat_at <= ?
  AND dsi.status = 'active'
  AND dsi.revoked_at IS NULL
  AND de.status = 'active'
  AND de.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM connector_attention_records car
    WHERE car.attention_id =
      'att_device_silence_' || dsi.source_instance_id || '_' ||
      REPLACE(REPLACE(REPLACE(dsi.last_heartbeat_at, '-', ''), ':', ''), '.', '')
      AND (
        json_extract(car.record_json, '$.notification_updated_at') IS NOT NULL
        OR car.lifecycle <> 'open'
      )
  )
ORDER BY (
    SELECT COUNT(*) FROM connector_attention_records car
    WHERE car.attention_id =
      'att_device_silence_' || dsi.source_instance_id || '_' ||
      REPLACE(REPLACE(REPLACE(dsi.last_heartbeat_at, '-', ''), ':', ''), '.', '')
  ) ASC,
  (
    SELECT car.updated_at FROM connector_attention_records car
    WHERE car.attention_id =
      'att_device_silence_' || dsi.source_instance_id || '_' ||
      REPLACE(REPLACE(REPLACE(dsi.last_heartbeat_at, '-', ''), ':', ''), '.', '')
  ) ASC,
  dsi.last_heartbeat_at ASC, dsi.device_id ASC, dsi.source_instance_id ASC
LIMIT ?
