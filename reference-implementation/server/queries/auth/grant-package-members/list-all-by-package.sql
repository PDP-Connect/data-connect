-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grant_package_members
-- @max_rows: 256
SELECT gm.package_id,
       gm.grant_id,
       gm.source_json,
       gm.status AS member_status,
       gm.added_at,
       gm.revoked_at AS member_revoked_at,
       g.status AS grant_status,
       -- Reported lifecycle is derived from status, expires_at and now, in
       -- server/grant-lifecycle.ts. `status` alone never says 'expired'.
       g.expires_at AS grant_expires_at,
       g.access_mode AS grant_access_mode
FROM grant_package_members gm
JOIN grants g ON gm.grant_id = g.grant_id
WHERE gm.package_id = ?
ORDER BY gm.added_at, gm.grant_id
