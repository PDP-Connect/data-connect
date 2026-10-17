-- @terminator: exec
-- Erase one connection's webhook run receipts as part of the connection-delete
-- cascade, so a webhook replay cannot return a deleted connection's run handle
-- for a re-added connection with the same id. source_webhook_events (the
-- provider event dedupe, no connection column) is kept.
DELETE FROM source_webhook_run_receipts WHERE connector_instance_id = ?
