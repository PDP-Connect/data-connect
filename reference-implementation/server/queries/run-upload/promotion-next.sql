-- @terminator: one
SELECT * FROM connector_run_upload_stages WHERE connection_id=? AND stream=? AND record_key=? AND stage_id > ? ORDER BY stage_id LIMIT 1
