-- @terminator: exec
-- Parameters: instance, connector, scope_key, record_key, embedding, source_version.
-- source_version is the records.version the embedding was computed from; NULL
-- means unknown (callers that do not know the version) and is never current.
INSERT INTO semantic_search_blob(connector_instance_id, connector_id, scope_key, record_key, embedding, source_version)
VALUES(?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id, scope_key, record_key) DO UPDATE SET
  connector_id = excluded.connector_id,
  embedding = excluded.embedding,
  source_version = excluded.source_version
