-- @terminator: exec
DELETE FROM connector_run_upload_stages
WHERE owner_id = ? AND connection_id = ? AND run_id = ? AND issuer_epoch = ? AND generation = ?
