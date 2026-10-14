-- @terminator: exec
-- Parameters: instance, connector, scope_key, record_key, rowid, source_version, source_generation.
INSERT INTO semantic_search_rowid(connector_instance_id, connector_id, scope_key, record_key, rowid, source_version, source_generation)
VALUES(?, ?, ?, ?, ?, ?, ?)
