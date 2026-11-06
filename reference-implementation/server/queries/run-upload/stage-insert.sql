-- @terminator: exec
INSERT INTO connector_run_upload_stages
(stage_id, blob_id, owner_id, connector_id, connection_id, run_id, issuer_epoch, generation,
 stream, record_key, json_path, mime_type, sha256, size_bytes, charge_bytes, data)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
