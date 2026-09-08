-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grant_package_members
-- @max_rows: 256
-- Member deadlines for ONE grant package, UNREDUCED.
--
-- `grants.expires_at` is TEXT, so reducing these with a SQL MAX() would be a
-- lexicographic max rather than a chronological one and would disagree with
-- the detail route. Every row is returned and the reduction happens in
-- server/grant-lifecycle.ts, the same shared function the detail route uses.
--
-- Scoped to one package by `WHERE`, so the bound is the SAME per-package
-- invariant that `list-all-by-package.sql` already carries (256 members per
-- package). An earlier revision selected the whole joined membership table and
-- filtered in JS, which turned a per-package bound into a GLOBAL one:
-- memberships in unrelated packages could then overflow the annotation and
-- fail a small page of packages that were themselves well within it.
SELECT gpm.package_id,
       g.expires_at AS grant_expires_at
FROM grant_package_members gpm
JOIN grants g ON gpm.grant_id = g.grant_id
WHERE gpm.package_id = ?
