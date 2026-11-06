-- @terminator: one
SELECT * FROM connector_run_upload_stages
WHERE connection_id = ? AND run_id = ? AND issuer_epoch = ? AND generation = ?
  AND stream = ? AND record_key = ? AND json_path = ?
