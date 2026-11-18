-- @terminator: exec
INSERT INTO semantic_search_blob(connector_instance_id, connector_id, scope_key, record_key, embedding, input_identity)
VALUES(?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id, scope_key, record_key) DO UPDATE SET
  connector_id = excluded.connector_id,
  embedding = excluded.embedding,
  input_identity = excluded.input_identity

WHERE semantic_search_blob.embedding IS NOT excluded.embedding
   OR semantic_search_blob.input_identity IS NOT excluded.input_identity
