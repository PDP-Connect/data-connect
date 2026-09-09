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
-- The NOT EXISTS is what keeps this cheap. It excludes any instance that already
-- had its CURRENT silence episode delivered to the owner, so each tick returns
-- only work nobody has finished. That makes the result set shrink as the sweep makes
-- progress, which in turn means LIMIT alone is a complete answer to batching: a
-- bounded batch of unreported rows cannot starve anything, because handling a
-- row removes it from the next tick's results. Selecting every silent instance
-- and paging over it instead needs a cursor to make progress, a place to keep
-- the cursor across restarts, a wrap rule, and agreement between the caller's
-- page size and the store's own row cap — none of which buy a notification.
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
-- Neither test alone is sufficient. Excluding only on the delivery outcome loses
-- owner decisions made before a first delivery succeeded. Excluding on the
-- record existing at all would drop a notice permanently whenever the notifier
-- failed before handing the push over, since that path records nothing. Together
-- they mean: retry while the notice is untouched and undelivered, and stop as
-- soon as either the owner or the delivery has moved it on.
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
  dsi.last_heartbeat_at ASC, dsi.device_id ASC, dsi.source_instance_id ASC
LIMIT ?
