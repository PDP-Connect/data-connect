-- @terminator: one
SELECT COALESCE(SUM(charge_bytes), 0) AS charge_bytes FROM connector_run_upload_stages
