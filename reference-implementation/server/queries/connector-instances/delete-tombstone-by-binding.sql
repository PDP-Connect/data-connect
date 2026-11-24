-- @terminator: exec
-- Clears the owner-delete tombstone for one connector-instance identity. Run
-- ONLY on an explicit owner connect of that identity (the owner asked to add
-- the source again); implicit materialization paths keep respecting the
-- tombstone. Spec: openspec/changes/fix-owner-delete-resurrection.
DELETE FROM connector_instance_tombstones
WHERE owner_subject_id = ?
  AND connector_id = ?
  AND source_kind = ?
  AND source_binding_key = ?
