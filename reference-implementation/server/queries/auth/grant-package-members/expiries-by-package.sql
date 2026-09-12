-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grant_package_members
-- @max_rows: 256
-- Member lifecycle inputs for ONE grant package, UNREDUCED, ONE PAGE AT A TIME.
--
-- Returns `status` and `expires_at` alongside the deadline because a package's
-- lifecycle depends on revocation as well as expiry: a member revoked before
-- its deadline carries no `expires_at` at all, and reducing on deadlines alone
-- reported a fully-revoked package as 'active'. See server/grant-lifecycle.ts.
--
-- `grants.expires_at` is TEXT, so reducing these with a SQL MAX() would be a
-- lexicographic max rather than a chronological one and would disagree with
-- the detail route. Every row is returned and the reduction happens in
-- server/grant-lifecycle.ts, the same shared function the detail route uses.
--
-- KEYSET-PAGED, and @max_rows is a bound on ONE PAGE rather than an assumed
-- ceiling on membership. The previous revision declared 256 as if it were an
-- established per-package invariant; no issuance path enforces any such
-- ceiling, so a 257-member package made `allowUnboundedReadAcknowledged` throw
-- SmallEnumerationOverflowError and failed the whole list route. The caller
-- (listMemberExpiriesByPackage) loops on `grant_id > ?` until a short page
-- comes back, so any member count reads correctly and the declared bound is
-- now something the query actually guarantees.
--
-- ORDER BY gpm.grant_id is what makes the keyset total and stable: grant_id is
-- the primary key of the membership row within a package, so it is unique and
-- never rewritten, and no member can be skipped or repeated across pages.
SELECT gpm.package_id,
       gpm.grant_id,
       gpm.status AS member_status,
       g.status AS grant_status,
       g.expires_at AS grant_expires_at
FROM grant_package_members gpm
JOIN grants g ON gpm.grant_id = g.grant_id
WHERE gpm.package_id = ?
  AND gpm.grant_id > ?
ORDER BY gpm.grant_id
LIMIT 256
