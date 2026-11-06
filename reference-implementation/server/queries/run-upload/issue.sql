-- @terminator: exec
UPDATE connector_run_upload_permissions SET generation = ?, token_digest = ?, grant_json = ?, revoked = 0 WHERE connection_id = ?
