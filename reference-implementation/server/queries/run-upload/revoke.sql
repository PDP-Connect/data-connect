-- @terminator: exec
UPDATE connector_run_upload_permissions SET revoked = 1 WHERE connection_id = ?
