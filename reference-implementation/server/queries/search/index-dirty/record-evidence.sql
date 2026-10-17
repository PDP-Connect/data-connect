-- @terminator: exec
-- Diagnostic message only (write-path index maintenance failure). Never touches
-- attempts / next_attempt_at / dirty / revision.
UPDATE search_index_dirty SET last_error = ? WHERE connector_instance_id = ? AND stream = ?
