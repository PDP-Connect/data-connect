-- @terminator: iterate
-- @cursor_field: connection_id
SELECT connection_id FROM connector_run_upload_permissions UNION SELECT connection_id FROM connector_run_upload_stages ORDER BY connection_id
