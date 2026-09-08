-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grant_package_members
-- @max_rows: 1024
-- Member deadlines for one page of grant packages, UNREDUCED.
--
-- `grants.expires_at` is TEXT, so reducing these with a SQL MAX() would be a
-- lexicographic max rather than a chronological one and would disagree with
-- the detail route. Every row is returned and the reduction happens in
-- server/grant-lifecycle.ts, the same shared function the detail route uses.
--
-- The reference is a single-owner instance, so the package listing is bounded
-- by the same small_enumeration_table budget as the listing it accompanies.
SELECT gpm.package_id,
       g.expires_at AS grant_expires_at
FROM grant_package_members gpm
JOIN grants g ON gpm.grant_id = g.grant_id
