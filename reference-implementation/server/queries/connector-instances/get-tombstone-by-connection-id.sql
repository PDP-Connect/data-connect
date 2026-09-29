-- @terminator: one
-- Reads the owner-delete tombstone of one deleted connection id. Used ONLY by
-- the owner-session browser-profile purge retry, which must accept a deleted
-- connection. Spec: openspec/changes/fix-owner-delete-resurrection.
SELECT
  connector_instance_id,
  owner_subject_id,
  connector_id,
  source_kind,
  source_binding_key,
  deleted_at
FROM connector_instance_tombstones
WHERE connector_instance_id = ?
LIMIT 1;
