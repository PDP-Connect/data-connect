-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grant_package_members
-- @max_rows: 256
-- Every member of ONE grant package, revoked rows included, ONE PAGE AT A TIME.
--
-- KEYSET-PAGED, and @max_rows bounds ONE PAGE rather than asserting a ceiling
-- on membership. The previous revision declared 256 as though a per-package
-- maximum existed; no issuance path enforces one --
-- `createHostedMcpGrantPackage` writes one member per approved authorization
-- detail and never counts them -- so a 257-member package made
-- `allowUnboundedReadAcknowledged` throw SmallEnumerationOverflowError and
-- failed the owner's package DETAIL route outright. The list route was paged
-- in an earlier revision; this read was left carrying the same false
-- assumption. The caller loops on the keyset below until a short page comes
-- back, so any member count reads correctly and the declared bound is now a
-- property the SQL actually guarantees.
--
-- The keyset is the COMPOSITE (added_at, grant_id), matching ORDER BY exactly.
-- `added_at` alone is not unique -- every member of a package issued in one
-- transaction shares an identical timestamp -- so paging on it alone would
-- skip or repeat rows. Pairing it with grant_id, the membership primary key
-- within a package, makes the ordering total and the keyset stable.
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
  AND (gm.added_at > ? OR (gm.added_at = ? AND gm.grant_id > ?))
ORDER BY gm.added_at, gm.grant_id
LIMIT 256
