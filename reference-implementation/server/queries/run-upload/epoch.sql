-- @terminator: exec
INSERT INTO connector_run_upload_permissions (connection_id, issuer_epoch, generation, revoked) VALUES (?, ?, -1, 1) ON CONFLICT(connection_id) DO UPDATE SET issuer_epoch = excluded.issuer_epoch, revoked = 1
